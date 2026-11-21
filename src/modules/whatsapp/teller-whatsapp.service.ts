import 'server-only';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  normalizeMessageContent,
  type BinaryNode,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';
import { isPrivateChat, TELLER_SESSION_PREFIX, tellerSessionPrefix } from './accounts';
import { clearSession, databaseAuthState, hasSession } from './auth-state';
import { mediaMark } from './bot-store';
import { keepImage, keepMedia, MAX_KEPT_MEDIA, readyImage } from './chat-images';
import { customerNames, shownName } from './chat-names';
import { quoteOf, quotedStanzaId } from './wa-quote';
import { changeRefusal, changesAllowed } from './message-change';
import { candidateNumbers } from './inbox-numbers';
import { installSignalFilter, isOwnDecryptFailure, countHidden } from './signal-noise';

/**
 * Each teller's own WhatsApp number, linked by the teller from the inbox.
 *
 * Kept apart from the office's numbers: no bot, no groups, no forwarding. What
 * people write to it, and what the teller writes from it here or on the phone,
 * is kept for that teller alone — the manager does not read it.
 */

const log = createLogger('whatsapp-teller');

/** Past this a message missed while the link was down is not shown as new. */
const STALE_AFTER_MS = 30 * 60_000;
const REPLACED_WAIT_MS = 2 * 60_000;
const MAX_TEXT = 2000;

type Status = 'OFF' | 'CONNECTING' | 'WAITING_QR' | 'CONNECTED';

interface Holder {
  sock: WASocket | null;
  status: Status;
  qr: string | null;
  me: string | null;
  error: string | null;
  retry: ReturnType<typeof setTimeout> | null;
  generation: number;
  /** Linking by number rather than QR: the number, then the code WhatsApp gives for it. */
  pairPhone: string | null;
  pairingCode: string | null;
  /** The names of the number's groups, read once each. */
  groupNames?: Map<string, string>;
}

const globalForTellers = globalThis as unknown as { __ifmsTellerNumbers?: Map<string, Holder> };
const holders: Map<string, Holder> = (globalForTellers.__ifmsTellerNumbers ??= new Map());

installSignalFilter();

const holderOf = (userId: string): Holder => {
  let found = holders.get(userId);
  if (!found) {
    found = {
      sock: null,
      status: 'OFF',
      qr: null,
      me: null,
      error: null,
      retry: null,
      generation: 0,
      pairPhone: null,
      pairingCode: null,
    };
    holders.set(userId, found);
  }
  return found;
};

const quiet = {
  level: 'warn',
  child() {
    return quiet;
  },
  trace() {},
  debug() {},
  info() {},
  warn(obj: unknown, msg?: string) {
    log.warn(msg ?? 'baileys', { detail: obj });
  },
  error(obj: unknown, msg?: string) {
    if (isOwnDecryptFailure(obj, msg)) {
      countHidden();
      return;
    }
    log.error(msg ?? 'baileys', { detail: obj });
  },
};

const digitsOf = (jid: string | null | undefined) =>
  jid?.endsWith('@s.whatsapp.net') ? jid.split('@')[0]!.split(':')[0]! : null;

interface KeepExtra {
  mediaId?: string | null;
  mediaKind?: string | null;
  waId?: string | null;
  quotedWaId?: string | null;
  /** The name the customer goes by on WhatsApp. */
  name?: string | null;
  /** In a group: the group's own name, and who wrote this message. */
  groupName?: string | null;
  authorName?: string | null;
}

/**
 * Keeps one message of a teller's conversation.
 *
 * WhatsApp writes to a person under their number or under a hidden id (@lid),
 * and the same person can arrive under both; they are one conversation, found
 * by either.
 */
async function keep(
  ownerId: string,
  chat: string,
  phoneJid: string | null,
  fromMe: boolean,
  text: string,
  extra: KeepExtra = {},
): Promise<string> {
  // A group is found by its address alone: it has no number, and its members are not it.
  const group = chat.endsWith('@g.us');
  const phone = group ? null : (digitsOf(phoneJid) ?? digitsOf(chat));
  const now = new Date();
  const found = await prisma.tellerChat.findFirst({
    where: { ownerId, OR: [{ chat }, ...(phone ? [{ phone }] : [])] },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });
  const named = group
    ? extra.groupName?.trim()
      ? { name: extra.groupName.trim().slice(0, 80) }
      : {}
    : !fromMe && extra.name?.trim()
      ? { name: extra.name.trim().slice(0, 80) }
      : {};
  const counted = fromMe ? {} : { unread: { increment: 1 } };
  const row = found
    ? await prisma.tellerChat.update({
        where: { id: found.id },
        data: { lastMessageAt: now, ...(phone ? { phone } : {}), ...named, ...counted },
        select: { id: true },
      })
    : await prisma.tellerChat.create({
        data: { ownerId, chat, phone, lastMessageAt: now, ...named, unread: fromMe ? 0 : 1 },
        select: { id: true },
      });
  const quoted = extra.quotedWaId
    ? await prisma.tellerChatMessage.findFirst({
        where: { chatId: row.id, waId: extra.quotedWaId },
        select: { id: true },
      })
    : null;
  await prisma.tellerChatMessage.create({
    data: {
      chatId: row.id,
      fromMe,
      authorName: group && !fromMe ? (extra.authorName?.trim().slice(0, 80) || null) : null,
      text: text.slice(0, MAX_TEXT),
      imageId: extra.mediaId ?? null,
      mediaKind: extra.mediaKind ?? null,
      waId: extra.waId ?? null,
      quotedId: quoted?.id ?? null,
    },
  });
  return row.id;
}

/**
 * Conversations kept twice for one person, before they were found by number as
 * well as by address, made one again: the older's messages move to the newer.
 */
async function mergeTwins(ownerId: string): Promise<void> {
  const rows = await prisma.tellerChat.findMany({
    where: { ownerId, phone: { not: null } },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true, phone: true, unread: true },
  });
  const kept = new Map<string, { id: string; unread: number }>();
  for (const row of rows) {
    const first = kept.get(row.phone!);
    if (!first) {
      kept.set(row.phone!, { id: row.id, unread: row.unread });
      continue;
    }
    await prisma.$transaction([
      prisma.tellerChatMessage.updateMany({
        where: { chatId: row.id },
        data: { chatId: first.id },
      }),
      prisma.tellerChat.update({
        where: { id: first.id },
        data: { unread: { increment: row.unread } },
      }),
      prisma.tellerChat.delete({ where: { id: row.id } }),
    ]);
  }
}

/** A file in a message the teller's number received, kept for the conversation; null for none. */
async function keepIncomingMedia(
  message: Parameters<typeof downloadMediaMessage>[0],
  content: NonNullable<ReturnType<typeof normalizeMessageContent>>,
  sock: WASocket,
  ownerId: string,
) {
  const file =
    content.imageMessage ??
    content.videoMessage ??
    content.audioMessage ??
    content.documentMessage ??
    null;
  if (!file || Number(file.fileLength ?? 0) > MAX_KEPT_MEDIA) return null;
  const data = (await downloadMediaMessage(
    message,
    'buffer',
    {},
    { logger: quiet as never, reuploadRequest: sock.updateMediaMessage },
  ).catch(() => null)) as Buffer | null;
  if (!data) return null;
  return keepMedia(
    {
      bytes: data,
      mimeType: file.mimetype ?? 'application/octet-stream',
      fileName: content.documentMessage?.fileName ?? null,
    },
    ownerId,
  );
}

/** A group's name, asked of WhatsApp once and kept. */
async function groupNameOf(holder: Holder, sock: WASocket, chat: string): Promise<string | null> {
  holder.groupNames ??= new Map();
  const known = holder.groupNames.get(chat);
  if (known) return known;
  const subject = await sock
    .groupMetadata(chat)
    .then((meta) => meta.subject?.trim() || null)
    .catch(() => null);
  if (subject) holder.groupNames.set(chat, subject);
  return subject;
}

async function open(userId: string): Promise<void> {
  const holder = holderOf(userId);
  const generation = ++holder.generation;
  holder.status = 'CONNECTING';
  holder.error = null;
  const prefix = tellerSessionPrefix(userId);

  const { state, saveCreds } = await databaseAuthState(prisma, prefix);
  const version = await fetchLatestBaileysVersion()
    .then((latest) => latest.version)
    .catch(() => undefined);

  const sock = makeWASocket({
    auth: state,
    logger: quiet,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    /*
     * A teller's own number is in their family's groups, hears every contact's
     * status, and carries years of history. None of it is a customer writing to
     * them, and decrypting it all, and keeping a key for every member of every
     * group, held up the whole server — twice now: reading every group again on
     * 2026-11-21 slowed it within the hour. It is acknowledged and dropped unread.
     */
    shouldIgnoreJid: (jid) =>
      Boolean(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)),
    shouldSyncHistoryMessage: () => false,
    defaultQueryTimeoutMs: 15_000,
    ...(version ? { version } : {}),
  });
  holder.sock = sock;

  // Unacknowledged status updates stop WhatsApp delivering to the link; see the office's numbers.
  sock.ws.on('CB:status', (node: BinaryNode) => {
    void sock.sendMessageAck(node).catch(() => undefined);
  });

  // What arrives as "notify": people writing, and the teller typing on the phone.
  // What this link sends arrives as "append" and is kept when it is sent.
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (generation !== holder.generation || type !== 'notify') return;
    for (const message of messages) {
      const chat = message.key.remoteJid;
      const inGroup = Boolean(chat && isJidGroup(chat));
      if (!chat || !(inGroup || isPrivateChat(chat))) continue;
      const sentAt = Number(message.messageTimestamp ?? 0) * 1000;
      if (sentAt > 0 && Date.now() - sentAt > STALE_AFTER_MS) continue;
      const content = normalizeMessageContent(message.message);
      if (!content || content.protocolMessage || content.reactionMessage) continue;
      const words =
        content.conversation ??
        content.extendedTextMessage?.text ??
        content.imageMessage?.caption ??
        content.videoMessage?.caption ??
        null;
      const media = Boolean(
        content.imageMessage ??
        content.videoMessage ??
        content.audioMessage ??
        content.documentMessage ??
        content.stickerMessage,
      );
      if (!words && !media) continue;
      // A note to oneself is not a customer.
      if (!inGroup && digitsOf(chat) && digitsOf(chat) === holder.me) continue;
      const phoneJid =
        [message.key.remoteJidAlt, chat].find((jid) => jid?.endsWith('@s.whatsapp.net')) ?? null;
      const fromMe = Boolean(message.key.fromMe);
      void (async () => {
        // A photo, voice note, video or document is shown; a sticker stays a clip.
        const kept = media ? await keepIncomingMedia(message, content, sock, userId) : null;
        const text = kept ? (words ?? '') : words ? (media ? `📎 ${words}` : words) : '📎';
        await keep(userId, chat, inGroup ? null : phoneJid, fromMe, text, {
          mediaId: kept?.id ?? null,
          mediaKind: kept?.kind ?? null,
          waId: message.key.id ?? null,
          quotedWaId: quotedStanzaId(message),
          name: inGroup ? null : (message.pushName ?? null),
          groupName: inGroup ? await groupNameOf(holder, sock, chat) : null,
          authorName: inGroup ? (message.pushName ?? null) : null,
        });
      })().catch((error) => log.warn('Could not keep a teller message', { error }));
    }
  });

  sock.ev.on('creds.update', () => {
    void saveCreds().catch((error) => log.error('Could not save a teller session', { error }));
  });

  sock.ev.on('connection.update', (update) => {
    if (generation !== holder.generation) return;
    if (update.qr) {
      holder.status = 'WAITING_QR';
      holder.qr = update.qr;
      // The socket is ready to be linked: by number, ask WhatsApp once for the code to type.
      if (holder.pairPhone && !holder.pairingCode) {
        const phone = holder.pairPhone;
        void sock
          .requestPairingCode(phone)
          .then((code) => {
            if (generation === holder.generation) holder.pairingCode = code;
          })
          .catch((error) => {
            log.warn('WhatsApp gave no pairing code', { error });
            holder.error = 'pairFailed';
          });
      }
    }
    if (update.connection === 'open') {
      holder.status = 'CONNECTED';
      holder.qr = null;
      holder.pairPhone = null;
      holder.pairingCode = null;
      holder.error = null;
      holder.me = digitsOf(sock.user?.id ? `${sock.user.id.split(':')[0]}@s.whatsapp.net` : null);
      log.info('A teller linked a number');
    }
    if (update.connection === 'close') {
      const code = (
        update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      holder.sock = null;
      holder.qr = null;
      if (code === DisconnectReason.loggedOut) {
        holder.status = 'OFF';
        holder.me = null;
        holder.error = 'loggedOut';
        void clearSession(prisma, prefix).catch(() => undefined);
        log.warn('A teller number was unlinked from the phone');
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        void open(userId).catch((error) => fail(userId, error));
        return;
      }
      const replaced = code === DisconnectReason.connectionReplaced;
      void hasSession(prisma, prefix).then((linked) => {
        if (generation !== holder.generation) return;
        if (!linked) {
          holder.status = 'OFF';
          holder.error = 'qrExpired';
          return;
        }
        holder.status = 'CONNECTING';
        holder.retry = setTimeout(
          () => {
            holder.retry = null;
            void open(userId).catch((error) => fail(userId, error));
          },
          replaced ? REPLACED_WAIT_MS : 5_000,
        );
      });
    }
  });
}

function fail(userId: string, error: unknown) {
  const holder = holderOf(userId);
  holder.status = 'OFF';
  holder.error = 'failed';
  log.error('A teller number could not connect', { error });
}

export interface TellerLink {
  status: Status;
  qrImage: string | null;
  /** The code to type on the phone, when linking by number. */
  pairingCode: string | null;
  number: string | null;
  error: string | null;
}

export async function linkOf(userId: string): Promise<TellerLink> {
  const holder = holderOf(userId);
  return {
    status: holder.status,
    qrImage:
      holder.qr && !holder.pairPhone
        ? await QRCode.toDataURL(holder.qr, { margin: 1, width: 280 })
        : null,
    pairingCode: holder.pairingCode,
    number: holder.me,
    error: holder.error,
  };
}

/** Starts linking: a QR to scan, or the number back on when it is linked already. */
export async function startLink(userId: string, typedPhone?: string): Promise<TellerLink> {
  const holder = holderOf(userId);
  // By number: on a phone the QR is on the screen that would have to scan it.
  if (typedPhone !== undefined) {
    const candidates = candidateNumbers(typedPhone);
    if (candidates.length !== 1) {
      throw errors.precondition(
        'Write the number with its country code',
        'errors.tellerPairNeedsCode',
      );
    }
    if (holder.status !== 'CONNECTED') {
      // A QR already waiting is dropped, so the link starts again asking for a code.
      if (holder.sock) holder.sock.end(undefined);
      holder.generation += 1;
      Object.assign(holder, { sock: null, status: 'OFF', qr: null });
    }
    holder.pairPhone = candidates[0]!;
    holder.pairingCode = null;
  } else {
    holder.pairPhone = null;
    holder.pairingCode = null;
  }
  if (holder.status === 'OFF') {
    if (holder.retry) clearTimeout(holder.retry);
    holder.retry = null;
    await open(userId).catch((error) => fail(userId, error));
  }
  return linkOf(userId);
}

/** Unlinks the teller's number: off the phone's linked devices, and its keys gone. */
export async function unlink(userId: string): Promise<TellerLink> {
  const holder = holderOf(userId);
  holder.generation += 1;
  if (holder.retry) clearTimeout(holder.retry);
  holder.retry = null;
  const sock = holder.sock;
  Object.assign(holder, { sock: null, status: 'OFF', qr: null, me: null, error: null });
  if (sock) await sock.logout().catch(() => sock.end(undefined));
  await clearSession(prisma, tellerSessionPrefix(userId));
  return linkOf(userId);
}

/** At server start: every teller's number that was linked, back on. */
export async function resumeTellerNumbers(): Promise<void> {
  const rows = await prisma.whatsappAuth.findMany({
    where: { key: { startsWith: TELLER_SESSION_PREFIX, endsWith: ':creds' } },
    select: { key: true },
  });
  for (const { key } of rows) {
    const userId = key.slice(TELLER_SESSION_PREFIX.length, -':creds'.length);
    if (!userId || holderOf(userId).status !== 'OFF') continue;
    await mergeTwins(userId).catch((error) => log.warn('Could not merge conversations', { error }));
    if (!(await hasSession(prisma, tellerSessionPrefix(userId)))) continue;
    await open(userId).catch((error) => fail(userId, error));
  }
}

function socketOf(userId: string): WASocket {
  const holder = holderOf(userId);
  if (holder.status !== 'CONNECTED' || !holder.sock) {
    throw errors.precondition('Your number is not linked', 'errors.tellerNumberNotLinked');
  }
  return holder.sock;
}

// ---------------------------------------------------------------------------
// The teller's conversations
// ---------------------------------------------------------------------------

export async function listChats(ownerId: string) {
  const rows = await prisma.tellerChat.findMany({
    where: { ownerId },
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { text: true, fromMe: true, imageId: true, mediaKind: true, deletedAt: true },
      },
    },
  });
  const records = await customerNames(rows.map((row) => row.phone));
  return rows.map((row) => ({
    id: row.id,
    phone: row.phone,
    name: shownName(row.phone, row.name, records),
    unread: row.unread,
    lastMessageAt: row.lastMessageAt,
    lastText: row.messages[0]?.deletedAt
      ? '🚫'
      : row.messages[0]?.text || mediaMark(row.messages[0]?.mediaKind, row.messages[0]?.imageId),
    group: row.chat.endsWith('@g.us'),
    // A group's talk is not a customer waiting on an answer.
    awaiting: row.messages[0] && !row.chat.endsWith('@g.us') ? !row.messages[0].fromMe : false,
  }));
}

/**
 * Whose numbers have conversations, for the manager watching them: each
 * person, how many conversations and how many unread, the busiest first.
 */
export async function watchedNumbers() {
  const owners = await prisma.tellerChat.groupBy({
    by: ['ownerId'],
    _count: { _all: true },
    _sum: { unread: true },
    _max: { lastMessageAt: true },
  });
  const people = await prisma.user.findMany({
    where: { id: { in: owners.map((owner) => owner.ownerId) } },
    select: { id: true, fullNameAr: true, fullNameEn: true },
  });
  return owners
    .map((owner) => {
      const person = people.find((entry) => entry.id === owner.ownerId);
      return {
        id: owner.ownerId,
        nameAr: person?.fullNameAr ?? '—',
        nameEn: person?.fullNameEn ?? '—',
        chats: owner._count._all,
        unread: owner._sum.unread ?? 0,
        lastMessageAt: owner._max.lastMessageAt,
      };
    })
    .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0));
}

/** How many of their customers' messages the teller has not opened. */
export async function unreadCount(ownerId: string): Promise<number> {
  const total = await prisma.tellerChat.aggregate({
    where: { ownerId, NOT: { chat: { endsWith: '@g.us' } } },
    _sum: { unread: true },
  });
  return total._sum.unread ?? 0;
}

export async function readChat(ownerId: string, id: string, options: { watching?: boolean } = {}) {
  const row = await prisma.tellerChat.findFirst({
    where: { id, ownerId },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 300 } },
  });
  // Another teller's conversation is not found, rather than forbidden: it is not theirs to know of.
  if (!row) throw errors.notFound('TellerChat', id);
  // Read by the manager watching, it is still unread for the teller whose customer wrote.
  if (row.unread > 0 && !options.watching) {
    await prisma.tellerChat.update({ where: { id: row.id }, data: { unread: 0 } });
  }
  const records = await customerNames([row.phone]);
  const now = Date.now();
  return {
    id: row.id,
    phone: row.phone,
    name: shownName(row.phone, row.name, records),
    group: row.chat.endsWith('@g.us'),
    messages: row.messages.reverse().map((message) => {
      const kind = message.mediaKind ?? (message.imageId ? 'image' : null);
      const deleted = Boolean(message.deletedAt);
      return {
        id: message.id,
        role: message.fromMe ? ('staff' as const) : ('customer' as const),
        text: deleted ? '' : message.text,
        imageId: deleted ? null : message.imageId,
        mediaKind: deleted ? null : kind,
        quotedId: message.quotedId,
        quotable: Boolean(message.waId) && !deleted,
        authorName: message.authorName ?? null,
        createdAt: message.createdAt,
        edited: Boolean(message.editedAt),
        deleted,
        ...changesAllowed(
          {
            ours: message.fromMe,
            waId: message.waId,
            mediaKind: kind,
            deletedAt: message.deletedAt,
            createdAt: message.createdAt,
          },
          now,
        ),
      };
    }),
  };
}

/**
 * An answer from the teller's number; with a photo, the words go under it. Given
 * a message of the conversation, the answer quotes it.
 */
export async function answer(
  ownerId: string,
  id: string,
  text: string,
  photo?: string,
  quoteId?: string,
) {
  const words = text.trim();
  const image = photo ? readyImage(photo) : null;
  if (!words && !image) throw errors.validation([{ path: 'text', message: 'Write the answer' }]);
  const row = await prisma.tellerChat.findFirst({ where: { id, ownerId } });
  if (!row) throw errors.notFound('TellerChat', id);
  const target = quoteId
    ? await prisma.tellerChatMessage.findFirst({
        where: { id: quoteId, chatId: row.id, waId: { not: null } },
        select: { waId: true, fromMe: true, text: true },
      })
    : null;
  const quoted = target?.waId ? quoteOf(row.chat, target.waId, target.fromMe, target.text) : null;
  const sock = socketOf(ownerId);
  let waId: string | null = null;
  try {
    const sent = await sock.sendMessage(
      row.chat,
      image
        ? { image: image.bytes, mimetype: image.mimeType, caption: words.slice(0, MAX_TEXT) }
        : { text: words.slice(0, MAX_TEXT) },
      quoted ? { quoted } : undefined,
    );
    waId = sent?.key.id ?? null;
  } catch (error) {
    log.warn('A teller message was not sent', { error });
    throw errors.precondition('WhatsApp did not take the message', 'errors.tellerSendFailed');
  }
  const imageId = image ? await keepImage(image, ownerId) : null;
  await keep(ownerId, row.chat, row.phone ? `${row.phone}@s.whatsapp.net` : null, true, words, {
    mediaId: imageId,
    mediaKind: imageId ? 'image' : null,
    waId,
    quotedWaId: target?.waId ?? null,
  });
  return readChat(ownerId, id);
}

/** A message the teller sent, edited or deleted for the customer too, as on the office's number. */
export async function changeMine(
  ownerId: string,
  id: string,
  messageId: string,
  change: { text: string } | { delete: true },
) {
  const row = await prisma.tellerChat.findFirst({ where: { id, ownerId } });
  if (!row) throw errors.notFound('TellerChat', id);
  const message = await prisma.tellerChatMessage.findFirst({
    where: { id: messageId, chatId: row.id },
  });
  if (!message) throw errors.notFound('TellerChatMessage', messageId);
  const words = 'text' in change ? change.text.trim().slice(0, MAX_TEXT) : '';
  if ('text' in change && !words) {
    throw errors.validation([{ path: 'text', message: 'Write the message' }]);
  }
  const refusal = changeRefusal(
    {
      ours: message.fromMe,
      waId: message.waId,
      mediaKind: message.mediaKind ?? (message.imageId ? 'image' : null),
      deletedAt: message.deletedAt,
      createdAt: message.createdAt,
    },
    'text' in change ? 'edit' : 'delete',
  );
  if (refusal) throw errors.precondition('This message cannot be changed', refusal);

  const key = { remoteJid: row.chat, fromMe: true, id: message.waId! };
  try {
    await socketOf(ownerId).sendMessage(
      row.chat,
      'text' in change ? { text: words, edit: key } : { delete: key },
    );
  } catch (error) {
    log.warn('A teller message was not changed', { error });
    throw errors.precondition('WhatsApp did not take the change', 'errors.tellerSendFailed');
  }
  await prisma.tellerChatMessage.update({
    where: { id: message.id },
    data: 'text' in change ? { text: words, editedAt: new Date() } : { deletedAt: new Date() },
  });
  return readChat(ownerId, id);
}

/** Writing first to a number, from the teller's own: the same daily ceiling as the office's. */
export async function startChat(ownerId: string, typedPhone: string, text: string) {
  const words = text.trim();
  if (!words) throw errors.validation([{ path: 'text', message: 'Write the message' }]);
  const candidates = candidateNumbers(typedPhone);
  if (candidates.length === 0) {
    throw errors.precondition('That is not a phone number', 'errors.inboxBadNumber');
  }
  const sock = socketOf(ownerId);

  let jid: string | null = null;
  for (const digits of candidates) {
    const found = await sock.onWhatsApp(`${digits}@s.whatsapp.net`).catch(() => undefined);
    jid = found?.find((entry) => entry.exists)?.jid ?? null;
    if (jid) break;
  }
  if (!jid) throw errors.precondition('That number has no WhatsApp', 'errors.inboxNoWhatsapp');

  const known = await prisma.tellerChat.findFirst({
    where: { ownerId, OR: [{ chat: jid }, { phone: digitsOf(jid) }] },
    select: { id: true, chat: true },
  });
  if (!known) {
    const ceiling = await settings.getNumber('whatsapp.inboxNewChatsPerDay');
    const opened = await prisma.tellerChat.count({
      where: {
        ownerId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        messages: { none: { fromMe: false } },
      },
    });
    if (opened >= ceiling) {
      throw errors.precondition('Too many new conversations today', 'errors.inboxDailyCeiling', {
        count: ceiling,
      });
    }
  }

  const chat = known?.chat ?? jid;
  let waId: string | null = null;
  try {
    const sent = await sock.sendMessage(chat, { text: words.slice(0, MAX_TEXT) });
    waId = sent?.key.id ?? null;
  } catch (error) {
    log.warn('A teller message was not sent', { error });
    throw errors.precondition('WhatsApp did not take the message', 'errors.tellerSendFailed');
  }
  return { id: await keep(ownerId, chat, jid, true, words, { waId }) };
}
