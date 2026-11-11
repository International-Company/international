import 'server-only';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  type BinaryNode,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { recordIssue } from './bot-issues';
import { countHidden, installSignalFilter, isOwnDecryptFailure } from './signal-noise';
import {
  ACCOUNTS,
  chooseAccount,
  firstSighting,
  GROUP_ACCOUNTS,
  groupEntry,
  isPrivateChat,
  SESSION_PREFIX,
  type Account,
} from './accounts';
import { clearSession, databaseAuthState, hasSession } from './auth-state';

/**
 * The office's WhatsApp numbers, linked the way WhatsApp Web is: the manager
 * opens the settings, a QR code appears, and the phone that holds the number
 * scans it from «الأجهزة المرتبطة». From then on the server is one of that
 * number's linked devices and can write to the groups it is in.
 *
 * Up to two numbers, each its own connection. A message goes out from whichever
 * of them is in the group it is for, so the rest of the system names groups and
 * never numbers. Both are kept on `globalThis` so the route bundles Next.js
 * builds separately all reach the same ones. Each resumes by itself when the
 * server starts with its session saved, and reconnects after a dropped line;
 * only an unlink from its phone ends it for good.
 *
 * Not WhatsApp's official API — that one cannot write to groups. Which is why
 * the numbers should be ones kept for the system, not somebody's own.
 */

const log = createLogger('whatsapp');

/** What reaches the private number, counted by how it came and from what kind of chat. */
const traffic = new Map<string, number>();
setInterval(() => {
  if (traffic.size === 0) return;
  log.info('Private number traffic, last five minutes', Object.fromEntries(traffic));
  traffic.clear();
}, 5 * 60_000).unref();

/** How long a copy knocked off by another waits before trying the number again. */
const REPLACED_WAIT_MS = 2 * 60_000;

export type LinkStatus = 'OFF' | 'CONNECTING' | 'WAITING_QR' | 'CONNECTED';
export type { Account } from './accounts';

interface Session {
  sock: WASocket | null;
  status: LinkStatus;
  qr: string | null;
  me: { id: string; name: string | null } | null;
  error: string | null;
  retry: ReturnType<typeof setTimeout> | null;
  /** Bumped whenever a socket is replaced, so a stale one's events are ignored. */
  generation: number;
  /** The groups this number is in, as last read, and when. */
  groups: Set<string> | null;
  groupsReadAt: number;
}

/** A text message someone else wrote, in a chat a linked number is in. */
export interface IncomingText {
  chat: string;
  text: string;
  /** The sender as WhatsApp addressed them — a phone JID, or an anonymous @lid. */
  sender: string | null;
  /** Their phone JID when WhatsApp said it outright. */
  senderPhone: string | null;
  message: WAMessage;
  /** The number that heard it. */
  account: Account;
  /** A picture, voice note or file sent to the private number, which cannot be read. */
  media?: boolean;
  /** A picture sent to the private number, with or without words. */
  image?: boolean;
}

/** A member of staff writing from the private number's own phone. */
export interface StaffMessage {
  chat: string;
  /** Null when WhatsApp did not let this device read it. */
  text: string | null;
}

type StaffListener = (message: StaffMessage) => Promise<void> | void;

type Listener = (incoming: IncomingText) => Promise<void> | void;

interface Shared {
  sessions: Record<Account, Session>;
  /** Who is told of a message arriving — kept here so a reconnect keeps them. */
  listeners: Listener[];
  staffListeners: StaffListener[];
  /** Messages already handled, when both numbers are in the chat they came to. */
  seen: string[];
}

const fresh = (): Session => ({
  sock: null,
  status: 'OFF',
  qr: null,
  me: null,
  error: null,
  retry: null,
  generation: 0,
  groups: null,
  groupsReadAt: 0,
});

const globalForWhatsapp = globalThis as unknown as { __ifmsWhatsappNumbers?: Shared };
const shared: Shared = (globalForWhatsapp.__ifmsWhatsappNumbers ??= {
  sessions: { main: fresh(), second: fresh(), private: fresh() },
  listeners: [],
  staffListeners: [],
  seen: [],
});
shared.staffListeners ??= [];
// A server already running when this number was added has no place for it yet.
shared.sessions.private ??= fresh();

installSignalFilter();

/** Baileys talks a great deal; only what is worth reading reaches our log. */
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

const prefixOf = (account: Account) => SESSION_PREFIX[account];

async function open(account: Account): Promise<void> {
  const holder = shared.sessions[account];
  const generation = ++holder.generation;
  holder.status = 'CONNECTING';
  holder.error = null;

  const { state, saveCreds } = await databaseAuthState(prisma, prefixOf(account));
  // WhatsApp refuses clients that claim an old version; ask which is current.
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
    ...(version ? { version } : {}),
  });
  holder.sock = sock;

  /*
   * WhatsApp now sends people's status updates as a stanza of their own, which
   * this version of the library never acknowledges. Left unacknowledged, the
   * server stops delivering messages to the link while it still looks
   * connected, and customers go unanswered with nothing in the log.
   */
  let statusSeen = false;
  sock.ws.on('CB:status', (node: BinaryNode) => {
    if (!statusSeen) {
      statusSeen = true;
      log.info('Acknowledging status updates', { account });
    }
    void sock
      .sendMessageAck(node)
      .catch((error) => log.warn('Could not acknowledge a status update', { account, error }));
  });

  /*
   * Messages as they arrive — "notify", not the history WhatsApp replays on
   * connecting, so a command typed while the server was down is not answered
   * hours later. The bots' own messages are never read back, and a message both
   * numbers see is handled once.
   */
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    // What reaches the private number from people, before anything is filtered: never who or what.
    if (account === 'private' && generation === holder.generation) {
      for (const message of messages) {
        const jid = message.key.remoteJid ?? '';
        const kind = jid.includes('@') ? jid.slice(jid.indexOf('@') + 1) : 'none';
        traffic.set(`${type}:${kind}`, (traffic.get(`${type}:${kind}`) ?? 0) + 1);
        if (kind === 'g.us' || kind === 'broadcast' || kind === 'newsletter') continue;
        log.info('A private chat message reached the link', {
          type,
          kind,
          fromMe: Boolean(message.key.fromMe),
          readable: Boolean(message.message),
          stub: message.messageStubType ?? null,
          reason: message.messageStubParameters?.[0] ?? null,
        });
      }
    }
    if (generation !== holder.generation || type !== 'notify') return;
    for (const message of messages) {
      if (!message.key.remoteJid) continue;
      // The private number hears people writing to it, and nothing else.
      if (account === 'private') {
        if (!isPrivateChat(message.key.remoteJid)) continue;
        // What this link sends itself arrives as "append": a "notify" of ours was typed on the phone.
        if (message.key.fromMe) {
          const typed = normalizeMessageContent(message.message);
          // Housekeeping between its own devices, and notes to itself, are nobody's conversation.
          const self = holder.me?.id.split(':')[0];
          if (
            typed?.protocolMessage ||
            typed?.reactionMessage ||
            message.key.remoteJid.split('@')[0] === self
          ) {
            continue;
          }
          const staff: StaffMessage = {
            chat: message.key.remoteJid,
            text: typed?.conversation ?? typed?.extendedTextMessage?.text ?? null,
          };
          for (const listener of shared.staffListeners) {
            void Promise.resolve()
              .then(() => listener(staff))
              .catch((error) => log.error('A WhatsApp staff handler failed', { error }));
          }
          continue;
        }
      }
      if (!firstSighting(shared.seen, `${message.key.remoteJid}:${message.key.id}`)) continue;
      const content = normalizeMessageContent(message.message);
      const caption =
        account === 'private'
          ? (content?.imageMessage?.caption ?? content?.videoMessage?.caption ?? null)
          : null;
      const text = content?.conversation ?? content?.extendedTextMessage?.text ?? caption;
      const media =
        account === 'private' &&
        !text &&
        Boolean(
          content?.imageMessage ??
            content?.audioMessage ??
            content?.videoMessage ??
            content?.documentMessage,
        );
      if (!text && !media) continue;
      // The office may type a command on the linked phone itself; nothing else it sends is heard.
      if (message.key.fromMe && !text?.trim().replace(/^[\u200e\u200f]+/, '').startsWith('#')) continue;
      const sender = message.key.participant ?? message.key.remoteJid;
      const phone =
        message.key.participantPn ??
        message.key.senderPn ??
        (sender?.endsWith('@s.whatsapp.net') ? sender : null);
      const incoming: IncomingText = {
        chat: message.key.remoteJid,
        text: text ?? '',
        media,
        image: account === 'private' && Boolean(content?.imageMessage),
        sender: sender ?? null,
        senderPhone: phone ?? null,
        message,
        account,
      };
      for (const listener of shared.listeners) {
        void Promise.resolve()
          .then(() => listener(incoming))
          .catch((error) => log.error('A WhatsApp message handler failed', { error }));
      }
    }
  });

  sock.ev.on('creds.update', () => {
    void saveCreds().catch((error) => log.error('Could not save the session', { error }));
  });

  // Joining a group makes this number the one to write to it, without waiting for a miss.
  sock.ev.on('groups.upsert', (joined) => {
    if (generation !== holder.generation) return;
    for (const group of joined) holder.groups?.add(group.id);
  });

  sock.ev.on('connection.update', (update) => {
    if (generation !== holder.generation) return;

    if (update.qr) {
      holder.status = 'WAITING_QR';
      holder.qr = update.qr;
    }

    if (update.connection === 'open') {
      holder.status = 'CONNECTED';
      holder.qr = null;
      holder.error = null;
      holder.me = sock.user ? { id: sock.user.id, name: sock.user.name ?? null } : null;
      log.info('WhatsApp linked', { account, id: holder.me?.id });
      void groupsOf(account, true).catch(() => undefined);
    }

    if (update.connection === 'close') {
      const code = (
        update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
      )?.output?.statusCode;
      holder.sock = null;
      holder.qr = null;

      if (code === DisconnectReason.loggedOut) {
        // Unlinked from the phone: the session is worthless now.
        holder.status = 'OFF';
        holder.me = null;
        holder.groups = null;
        holder.error = 'loggedOut';
        void clearSession(prisma, prefixOf(account)).catch(() => undefined);
        log.warn('WhatsApp was unlinked from the phone', { account });
        recordIssue('whatsapp', 'WhatsApp was unlinked from the phone', { account });
        return;
      }

      if (code === DisconnectReason.restartRequired) {
        // Normal straight after scanning: the phone asks for a fresh connection.
        void open(account).catch((error) => fail(account, error));
        return;
      }

      /*
       * Another copy of this server has taken the number, which is what a deploy
       * does for the moments both run. Taking it straight back has the two knock
       * each other off and both write the same keys, which can leave customers'
       * messages unreadable. The old copy is gone long before this waits out.
       */
      const replaced = code === DisconnectReason.connectionReplaced;
      if (replaced) log.warn('Another copy of the server took this number; waiting', { account });

      // A QR nobody scanned in time ends the attempt; anything else is a dropped line.
      void hasSession(prisma, prefixOf(account)).then((linked) => {
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
            void open(account).catch((error) => fail(account, error));
          },
          replaced ? REPLACED_WAIT_MS : 5_000,
        );
      });
    }
  });
}

function fail(account: Account, error: unknown) {
  const holder = shared.sessions[account];
  holder.status = 'OFF';
  holder.error = 'failed';
  log.error('WhatsApp connection failed', { account, error });
  recordIssue('whatsapp', 'WhatsApp connection failed', { account, error });
}

/** Starts linking a number: shows a QR when it is not linked, or resumes it when it is. */
export async function connect(account: Account = 'main'): Promise<void> {
  const holder = shared.sessions[account];
  if (
    holder.status === 'CONNECTED' ||
    holder.status === 'CONNECTING' ||
    holder.status === 'WAITING_QR'
  ) {
    return;
  }
  if (holder.retry) clearTimeout(holder.retry);
  holder.retry = null;
  await open(account);
}

/** At server start: resumes every linked number, and does nothing for one that is not. */
export async function resume(): Promise<void> {
  for (const account of ACCOUNTS) {
    const holder = shared.sessions[account];
    if (holder.sock || holder.status !== 'OFF') continue;
    if (!(await hasSession(prisma, prefixOf(account)))) continue;
    await open(account).catch((error) => fail(account, error));
  }
}

/** Unlinks a number: off its phone's linked devices, and out of the database. */
export async function disconnect(account: Account = 'main'): Promise<void> {
  const holder = shared.sessions[account];
  holder.generation += 1;
  if (holder.retry) clearTimeout(holder.retry);
  holder.retry = null;
  const sock = holder.sock;
  holder.sock = null;
  holder.status = 'OFF';
  holder.qr = null;
  holder.me = null;
  holder.error = null;
  holder.groups = null;
  if (sock) {
    await sock.logout().catch(() => sock.end(undefined));
  }
  await clearSession(prisma, prefixOf(account));
}

export interface LinkSnapshot {
  status: LinkStatus;
  /** The QR to scan, as an image, while one is waiting. */
  qrImage: string | null;
  /** The linked number, digits only. */
  number: string | null;
  name: string | null;
  error: string | null;
}

export async function snapshot(account: Account = 'main'): Promise<LinkSnapshot> {
  const holder = shared.sessions[account];
  return {
    status: holder.status,
    qrImage: holder.qr ? await QRCode.toDataURL(holder.qr, { margin: 1, width: 280 }) : null,
    number: holder.me ? holder.me.id.split(':')[0]!.split('@')[0]! : null,
    name: holder.me?.name ?? null,
    error: holder.error,
  };
}

const connected = (account: Account) =>
  shared.sessions[account].status === 'CONNECTED' && shared.sessions[account].sock !== null;

const live = (): Account[] => GROUP_ACCOUNTS.filter(connected);

/** Every number that can write to a group it is in, the private one last. */
const senders = (): Account[] => ACCOUNTS.filter(connected);

function socketOf(account: Account): WASocket {
  const holder = shared.sessions[account];
  if (holder.status !== 'CONNECTED' || !holder.sock) {
    throw errors.precondition('WhatsApp is not linked', 'errors.whatsappNotLinked');
  }
  return holder.sock;
}

/** The groups a number is in, read again when asked to or once the last reading is old. */
async function groupsOf(account: Account, reread = false) {
  const holder = shared.sessions[account];
  if (holder.groups && !reread) return holder.groups;
  const all = await socketOf(account).groupFetchAllParticipating();
  holder.groups = new Set(Object.keys(all));
  holder.groupsReadAt = Date.now();
  return holder.groups;
}

/**
 * The socket to write to a chat with. When neither number is known to be in a
 * group, their lists are read again once — at most every half minute, so a
 * group neither is in does not cost a reading for every message to it.
 */
async function socketFor(jid: string): Promise<WASocket> {
  const linked = senders();
  const memberOf = async (reread: boolean) =>
    Object.fromEntries(
      await Promise.all(
        linked.map(
          async (account) =>
            [account, await groupsOf(account, reread).catch(() => new Set<string>())] as const,
        ),
      ),
    );

  let known = await memberOf(false);
  if (
    jid.endsWith('@g.us') &&
    linked.length > 1 &&
    !linked.some((account) => known[account]?.has(jid)) &&
    linked.every((account) => Date.now() - shared.sessions[account].groupsReadAt > 30_000)
  ) {
    known = await memberOf(true);
  }
  const account = chooseAccount(jid, linked, known);
  if (!account) throw errors.precondition('WhatsApp is not linked', 'errors.whatsappNotLinked');
  return socketOf(account);
}

/** The groups the linked numbers are in, by name, each saying which number is in it. */
export async function groups(): Promise<
  { id: string; name: string; size: number; account: Account }[]
> {
  const linked = senders();
  if (linked.length === 0) {
    throw errors.precondition('WhatsApp is not linked', 'errors.whatsappNotLinked');
  }
  const found = new Map<string, { id: string; name: string; size: number; account: Account }>();
  let failure: unknown = null;
  let read = 0;
  for (const account of linked) {
    // One number not answering must not take the others' groups off the list.
    let all: Awaited<ReturnType<WASocket['groupFetchAllParticipating']>>;
    try {
      all = await socketOf(account).groupFetchAllParticipating();
    } catch (error) {
      log.warn('Could not read a number’s groups', { account, error });
      failure = error;
      continue;
    }
    read += 1;
    shared.sessions[account].groups = new Set(Object.keys(all));
    shared.sessions[account].groupsReadAt = Date.now();
    for (const group of Object.values(all)) {
      // A group both numbers are in is written to by the first, so it is listed as the first's.
      if (!found.has(group.id)) found.set(group.id, groupEntry(group, account));
    }
  }
  if (read === 0) throw failure;
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

/** Sends a picture, with a line under it, optionally as a reply. */
export async function sendImage(
  jid: string,
  image: Buffer,
  caption: string,
  quoted?: WAMessage,
  mimetype = 'image/png',
): Promise<SentMessage> {
  return (await socketFor(jid)).sendMessage(
    jid,
    { image, caption, mimetype },
    quoted ? { quoted } : undefined,
  );
}

/** Tells `listener` of every text message others write where a number is. */
export function onIncomingText(listener: Listener): void {
  shared.listeners.push(listener);
}

/** Tells `listener` when someone writes from the private number's phone. */
export function onStaffMessage(listener: StaffListener): void {
  shared.staffListeners.push(listener);
}

/**
 * A group member's phone JID, when WhatsApp hid it behind an anonymous @lid —
 * which it now does in many groups. The group's own member list pairs the two.
 */
export async function memberPhone(
  group: string,
  member: string,
  account: Account = 'main',
): Promise<string | null> {
  if (member.endsWith('@s.whatsapp.net')) return member;
  const metadata = await socketOf(account).groupMetadata(group);
  const found = metadata.participants.find(
    (participant) => participant.id === member || participant.lid === member,
  );
  if (found?.jid) return found.jid;
  return found?.id.endsWith('@s.whatsapp.net') ? found.id : null;
}

/** Whether any number is linked and connected. */
export function isLinked(): boolean {
  return live().length > 0;
}

export type SentMessage = Awaited<ReturnType<WASocket['sendMessage']>>;

/** Past this a file is left on the phone: it is held in memory while it is passed on. */
const MAX_FORWARD_BYTES = 30 * 1024 * 1024;

export type MediaKind = 'image' | 'video' | 'audio' | 'document';

export interface ForwardedMedia {
  kind: MediaKind;
  data: Buffer;
  mimeType: string;
  fileName?: string;
  /** A voice note rather than a sound file. */
  voice?: boolean;
}

/** The picture, video, sound or file in a message the private number received; null for none. */
export async function privateMedia(message: WAMessage): Promise<ForwardedMedia | null> {
  const content = normalizeMessageContent(message.message);
  const image = content?.imageMessage;
  const video = content?.videoMessage;
  const audio = content?.audioMessage;
  const document = content?.documentMessage;
  const found = image ?? video ?? audio ?? document;
  if (!found) return null;
  if (Number(found.fileLength ?? 0) > MAX_FORWARD_BYTES) throw new Error('File too large');

  const sock = socketOf('private');
  const data = (await downloadMediaMessage(
    message,
    'buffer',
    {},
    { logger: quiet as never, reuploadRequest: sock.updateMediaMessage },
  )) as Buffer;
  return {
    kind: image ? 'image' : video ? 'video' : audio ? 'audio' : 'document',
    data,
    mimeType: found.mimetype ?? 'application/octet-stream',
    fileName: document?.fileName ?? undefined,
    voice: audio?.ptt ?? undefined,
  };
}

/** Sends a picture, video, sound or file to a chat. A sound carries no caption. */
export async function sendMedia(
  jid: string,
  media: ForwardedMedia,
  caption: string,
): Promise<SentMessage> {
  const sock = await socketFor(jid);
  const { data, mimeType: mimetype } = media;
  switch (media.kind) {
    case 'image':
      return sock.sendMessage(jid, { image: data, caption, mimetype });
    case 'video':
      return sock.sendMessage(jid, { video: data, caption, mimetype });
    case 'audio':
      return sock.sendMessage(jid, { audio: data, mimetype, ptt: media.voice ?? false });
    case 'document':
      return sock.sendMessage(jid, {
        document: data,
        caption,
        mimetype,
        fileName: media.fileName ?? 'ملف',
      });
  }
}

/** Answers someone from the private number, showing it typing first as a person would. */
export async function replyPrivately(jid: string, text: string): Promise<void> {
  const sock = socketOf('private');
  await sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, Math.min(3_500, 1_000 + text.length * 15)));
  await sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
  // WhatsApp not answering must end in an error someone sees, not a reply that never comes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sock.sendMessage(jid, { text }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WhatsApp did not take the reply in time')), 45_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writes to a chat, optionally as a reply to a message already in it, and
 * hands back what was sent so a reply can be made to it in turn.
 */
export async function sendText(
  jid: string,
  text: string,
  quoted?: WAMessage,
): Promise<SentMessage> {
  return (await socketFor(jid)).sendMessage(jid, { text }, quoted ? { quoted } : undefined);
}
