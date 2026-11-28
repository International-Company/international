import 'server-only';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateMessageIDV2,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  normalizeMessageContent,
  toNumber,
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
import { quotedStanzaId } from './wa-quote';
import { withReaction } from './reactions';

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

/**
 * A message older than this when it reaches the link is not acted on: long
 * enough for one held up behind others, short of yesterday's.
 */
const STALE_AFTER_MS = 30 * 60_000;

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
  /** The words under a photo or video sent to a group; `text` is empty for one. */
  caption?: string;
}

/** A member of staff writing from the private number's own phone. */
export interface StaffMessage {
  chat: string;
  /** The customer's phone address, when the chat is under a hidden (@lid) one. */
  phone: string | null;
  /** Null when WhatsApp did not let this device read it. */
  text: string | null;
}

type StaffListener = (message: StaffMessage) => Promise<void> | void;

type Listener = (incoming: IncomingText) => Promise<void> | void;

/** Words this office's own number put in a group: sent by the app, or typed on its phone. */
export interface OwnGroupMessage {
  chat: string;
  /** WhatsApp's id for it, when known: what the forwarding log points back to. */
  id?: string | null;
  text: string;
  /** Whether the words are under a photo or video rather than on their own. */
  caption: boolean;
  /** The office number it was written from, as a phone JID, when known. */
  phone: string | null;
}

type OwnListener = (message: OwnGroupMessage) => Promise<void> | void;

/**
 * Anything seen in a group — written there by anyone, the office's numbers
 * included, with or without words — for the bank desk's view of its groups.
 * Told once per message; whoever listens decides which groups it keeps.
 */
export interface GroupSighting {
  chat: string;
  waId: string;
  fromMe: boolean;
  /** Who wrote it: their name on WhatsApp, and their number when WhatsApp gives it. */
  name: string | null;
  phone: string | null;
  /** Who wrote it as the group addresses them, when it was not the office. */
  author?: string | null;
  text: string;
  mediaKind: 'image' | 'video' | 'audio' | 'document' | null;
  at: Date;
  /** The file itself, fetched only by a listener that keeps it. */
  download?: () => Promise<{ bytes: Buffer; mimeType: string; fileName: string | null } | null>;
  /** WhatsApp's id of the message this one answers, when it quotes one. */
  quoted?: string | null;
  /** Forwarded on WhatsApp by a person, from wherever they read it. */
  forwarded?: boolean;
}

type GroupListener = (sighting: GroupSighting) => Promise<void> | void;

/**
 * A reaction put on a message in a group, or taken off it (`emoji` empty): the
 * bank desk reads ❤️ and 👍 on a transfer as "passed on" and "sent".
 */
export interface GroupReaction {
  chat: string;
  /** The message reacted to. */
  waId: string;
  emoji: string;
  fromMe: boolean;
  /** Who reacted, as the group addresses them, and their WhatsApp name. */
  author: string | null;
  name: string | null;
}

type ReactionListener = (reaction: GroupReaction) => Promise<void> | void;

interface Shared {
  sessions: Record<Account, Session>;
  /** Who is told of a message arriving — kept here so a reconnect keeps them. */
  listeners: Listener[];
  staffListeners: StaffListener[];
  /** Who is told of what the office's numbers write in groups. */
  ownListeners: OwnListener[];
  /** Who is told of everything seen in a group. */
  groupListeners: GroupListener[];
  reactionListeners: ReactionListener[];
  groupSeen: string[];
  /** Messages already handled, when both numbers are in the chat they came to. */
  seen: string[];
  /** What the app sent itself, so its echo from the phone is not told of twice. */
  ownSeen: string[];
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
  ownListeners: [],
  groupListeners: [],
  reactionListeners: [],
  groupSeen: [],
  seen: [],
  ownSeen: [],
});
shared.groupListeners ??= [];
shared.reactionListeners ??= [];
shared.groupSeen ??= [];
shared.staffListeners ??= [];
shared.ownListeners ??= [];
shared.ownSeen ??= [];
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
    /*
     * Contacts' statuses and channels are nobody's message to the office, and the
     * private number answers people, never groups. Each is acknowledged and
     * dropped before it is decrypted, which is most of the work a number does.
     */
    shouldIgnoreJid: (jid) =>
      Boolean(
        isJidBroadcast(jid) || isJidNewsletter(jid) || (account === 'private' && isJidGroup(jid)),
      ),
    /*
     * The library reads messages one at a time and, for one it cannot open,
     * asks WhatsApp about the sender. Unanswered, each question held every
     * message behind it for a minute; a shorter wait keeps customers moving.
     */
    defaultQueryTimeoutMs: 15_000,
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
      }
    }
    if (generation !== holder.generation || type !== 'notify') return;
    let stale = 0;
    for (const message of messages) {
      if (!message.key.remoteJid) continue;
      /*
       * What was missed while the link was down arrives as new. A question from
       * yesterday answered now, or a command run hours late, is worse than none:
       * whoever wrote it has been answered by a person or has moved on.
       */
      const sentAt = toNumber(message.messageTimestamp) * 1000;
      if (sentAt > 0 && Date.now() - sentAt > STALE_AFTER_MS) {
        stale++;
        continue;
      }
      // The private number hears people writing to it, and nothing else.
      if (account === 'private') {
        if (!isPrivateChat(message.key.remoteJid)) continue;
        // A reaction is kept on the message it is on: the customer's, or one put from the phone.
        const reacted = normalizeMessageContent(message.message)?.reactionMessage;
        if (reacted?.key?.id) {
          const who = message.key.fromMe ? 'me' : 'them';
          const waId = reacted.key.id;
          void (async () => {
            const target = await prisma.botMessage.findFirst({ where: { waId }, select: { id: true, reactions: true } });
            if (!target) return;
            await prisma.botMessage.update({
              where: { id: target.id },
              data: { reactions: withReaction(target.reactions, who, reacted.text ?? '') },
            });
          })().catch(() => undefined);
          continue;
        }
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
            phone:
              [message.key.remoteJid, message.key.remoteJidAlt].find((jid) =>
                jid?.endsWith('@s.whatsapp.net'),
              ) ?? null,
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
      // A reaction in a group: told of once, whichever number saw it, and nothing more to read in it.
      if (account !== 'private' && message.key.remoteJid.endsWith('@g.us') && message.key.id) {
        const reacted = normalizeMessageContent(message.message)?.reactionMessage;
        if (reacted) {
          if (
            reacted.key?.id &&
            firstSighting(shared.groupSeen, `reaction:${message.key.remoteJid}:${message.key.id}`)
          ) {
            const reaction: GroupReaction = {
              chat: message.key.remoteJid,
              waId: reacted.key.id,
              emoji: reacted.text ?? '',
              fromMe: Boolean(message.key.fromMe),
              author: message.key.participant ?? null,
              name: message.pushName ?? null,
            };
            for (const listener of shared.reactionListeners) {
              void Promise.resolve()
                .then(() => listener(reaction))
                .catch((error) => log.error('A WhatsApp reaction handler failed', { error }));
            }
          }
          continue;
        }
      }
      // Everything in a group, for the bank desk's view of it: words, files, the office's own.
      if (account !== 'private' && message.key.remoteJid.endsWith('@g.us') && message.key.id) {
        const seen = normalizeMessageContent(message.message);
        const file =
          seen?.imageMessage ?? seen?.videoMessage ?? seen?.audioMessage ?? seen?.documentMessage;
        const kind = seen?.imageMessage
          ? 'image'
          : seen?.videoMessage
            ? 'video'
            : seen?.audioMessage
              ? 'audio'
              : seen?.documentMessage
                ? 'document'
                : null;
        const words =
          seen?.conversation ??
          seen?.extendedTextMessage?.text ??
          seen?.imageMessage?.caption ??
          seen?.videoMessage?.caption ??
          seen?.documentMessage?.caption ??
          '';
        if ((words || kind) && !seen?.protocolMessage && !seen?.reactionMessage) {
          const author = message.key.participant ?? null;
          tellGroup({
            chat: message.key.remoteJid,
            waId: message.key.id,
            fromMe: Boolean(message.key.fromMe),
            author,
            name: message.pushName ?? null,
            phone:
              [message.key.participantAlt, author].find((jid) =>
                jid?.endsWith('@s.whatsapp.net'),
              ) ?? null,
            text: words,
            mediaKind: kind,
            quoted: quotedStanzaId(message),
            forwarded: Boolean(
              (
                seen?.extendedTextMessage ??
                seen?.imageMessage ??
                seen?.videoMessage ??
                seen?.documentMessage
              )?.contextInfo?.isForwarded,
            ),
            at: sentAt > 0 ? new Date(sentAt) : new Date(),
            download:
              file && Number(file.fileLength ?? 0) <= 16 * 1024 * 1024
                ? async () => {
                    const data = (await downloadMediaMessage(
                      message,
                      'buffer',
                      {},
                      { logger: quiet as never, reuploadRequest: sock.updateMediaMessage },
                    ).catch(() => null)) as Buffer | null;
                    return data
                      ? {
                          bytes: data,
                          mimeType: file.mimetype ?? 'application/octet-stream',
                          fileName: seen?.documentMessage?.fileName ?? null,
                        }
                      : null;
                  }
                : undefined,
          });
        }
      }
      // Typed on the linked phone into a group: the forwarding rules may pass it on.
      if (message.key.fromMe && message.key.remoteJid.endsWith('@g.us')) {
        const typed = normalizeMessageContent(message.message);
        const words = typed?.conversation ?? typed?.extendedTextMessage?.text ?? null;
        const under = typed?.imageMessage?.caption ?? typed?.videoMessage?.caption ?? null;
        if ((words ?? under) && message.key.id) {
          tellOwn(message.key.remoteJid, message.key.id, (words ?? under)!, !words, holder.me?.id);
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
      // A photo's words in a group: only the forwarding rules read them, never as a command.
      const groupCaption =
        account !== 'private' && message.key.remoteJid.endsWith('@g.us')
          ? (content?.imageMessage?.caption ?? content?.videoMessage?.caption ?? null)
          : null;
      if (!text && !media && !groupCaption) continue;
      // The office may type a command on the linked phone itself; nothing else it sends is heard.
      if (message.key.fromMe && !text?.trim().replace(/^[\u200e\u200f]+/, '').startsWith('#')) continue;
      const sender = message.key.participant ?? message.key.remoteJid;
      const phone =
        // The number behind a hidden (@lid) sender, when WhatsApp gives it.
        [message.key.participantAlt, message.key.remoteJidAlt].find((jid) =>
          jid?.endsWith('@s.whatsapp.net'),
        ) ??
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
        caption: groupCaption ?? undefined,
      };
      for (const listener of shared.listeners) {
        void Promise.resolve()
          .then(() => listener(incoming))
          .catch((error) => log.error('A WhatsApp message handler failed', { error }));
      }
    }
    if (stale > 0) log.info('Old messages left unanswered', { account, count: stale });
  });

  /*
   * How far the private number's answers got — delivered, read — for the
   * ticks in the inbox. Only a person's conversation on that number: the
   * groups the office's numbers write in say nothing the inbox shows.
   */
  sock.ev.on('messages.update', (updates) => {
    if (account !== 'private' || generation !== holder.generation) return;
    for (const { key, update } of updates) {
      const status = typeof update.status === 'number' ? update.status : null;
      if (!status || status < 2 || !key.fromMe || !key.id || !key.remoteJid || key.remoteJid.endsWith('@g.us')) continue;
      void prisma.botMessage
        .updateMany({
          where: { waId: key.id, role: { not: 'customer' }, OR: [{ ack: null }, { ack: { lt: status } }] },
          data: { ack: status },
        })
        .catch(() => undefined);
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
  const sock = await socketFor(jid);
  const sent = await sock.sendMessage(
    jid,
    { image, caption, mimetype },
    { ...(quoted ? { quoted } : {}), messageId: botPictureId(sock) },
  );
  if (sent?.key.id && jid.endsWith('@g.us')) {
    tellGroup({
      chat: jid,
      waId: sent.key.id,
      fromMe: true,
      name: null,
      phone: null,
      text: caption,
      mediaKind: 'image',
      at: new Date(),
      download: async () => ({ bytes: image, mimeType: mimetype, fileName: null }),
    });
  }
  tellOwn(jid, sent?.key.id, caption, true, sock.user?.id);
  return sent;
}

/** Tells `listener` of every text message others write where a number is. */
export function onIncomingText(listener: Listener): void {
  shared.listeners.push(listener);
}

/** Tells `listener` of what the office's own numbers write in a group. */
export function onOwnGroupMessage(listener: OwnListener): void {
  shared.ownListeners.push(listener);
}

/** Each message the office wrote in a group, told of once, whichever way it was seen first. */
function tellOwn(
  chat: string,
  id: string | null | undefined,
  text: string,
  caption: boolean,
  /** The office number that wrote it, as its JID. */
  from: string | null | undefined,
): void {
  if (!chat.endsWith('@g.us') || !text.trim()) return;
  if (id && !firstSighting(shared.ownSeen, `${chat}:${id}`)) return;
  // A linked JID carries the device after a colon: the number is what is before it.
  const phone = from ? `${from.split('@')[0]!.split(':')[0]}@s.whatsapp.net` : null;
  if (id) {
    tellGroup({
      chat,
      waId: id,
      fromMe: true,
      name: null,
      phone,
      text,
      mediaKind: caption ? 'image' : null,
      at: new Date(),
    });
  }
  const message: OwnGroupMessage = { chat, id: id ?? null, text, caption, phone };
  for (const listener of shared.ownListeners) {
    void Promise.resolve()
      .then(() => listener(message))
      .catch((error) => log.error('A WhatsApp group message handler failed', { error }));
  }
}

/** Tells `listener` of everything seen in a group, once each. */
export function onGroupSighting(listener: GroupListener): void {
  shared.groupListeners.push(listener);
}

/** Tells `listener` of each reaction put on, or taken off, a message in a group. */
export function onGroupReaction(listener: ReactionListener): void {
  shared.reactionListeners.push(listener);
}

function tellGroup(sighting: GroupSighting): void {
  if (!firstSighting(shared.groupSeen, `${sighting.chat}:${sighting.waId}`)) return;
  for (const listener of shared.groupListeners) {
    void Promise.resolve()
      .then(() => listener(sighting))
      .catch((error) => log.error('A WhatsApp group sighting handler failed', { error }));
  }
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
  if (found?.phoneNumber) return found.phoneNumber;
  return found?.id.endsWith('@s.whatsapp.net') ? found.id : null;
}

/** Deletes for everyone a message one of the office's numbers wrote to a chat. */
export async function deleteSent(jid: string, messageId: string): Promise<void> {
  const sock = await socketFor(jid);
  await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: messageId } });
}

/** The office's number that writes to this chat, as a phone JID; null when none can. */
export async function ownNumberFor(jid: string): Promise<string | null> {
  const sock = await socketFor(jid).catch(() => null);
  const id = sock?.user?.id;
  return id ? `${id.split('@')[0]!.split(':')[0]}@s.whatsapp.net` : null;
}

/** Whether a phone JID is one of this office's own linked numbers. */
export function isOwnNumber(phoneJid: string | null): boolean {
  const digits = phoneJid?.split('@')[0]?.split(':')[0];
  if (!digits) return false;
  return ACCOUNTS.some(
    (account) => connected(account) && shared.sessions[account].me?.id.split(':')[0] === digits,
  );
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

/*
 * The pictures the bot sends, by the id they go with — chosen before sending,
 * since WhatsApp tells of the bot's own message before the send returns. A
 * receipt the bot answers a transfer with quotes the transfer, exactly as a
 * person's would; without this it was read back as one more receipt — a
 * "part" — and, answered again under the copies, it never stopped.
 */
const botPictures = new Map<string, number>();
const BOT_PICTURE_MS = 24 * 60 * 60 * 1000;

function botPictureId(sock: WASocket): string {
  const id = generateMessageIDV2(sock.user?.id);
  const now = Date.now();
  botPictures.set(id, now);
  if (botPictures.size > 2000) {
    for (const [key, at] of botPictures) if (now - at > BOT_PICTURE_MS || botPictures.size > 2000) botPictures.delete(key);
  }
  return id;
}

/** Whether the bot itself sent this picture: never someone's receipt. */
export function sentByBot(waId: string): boolean {
  return botPictures.has(waId);
}

/** Sends a picture, video, sound or file to a chat. A sound carries no caption. */
export async function sendMedia(
  jid: string,
  media: ForwardedMedia,
  caption: string,
): Promise<SentMessage> {
  const sock = await socketFor(jid);
  const { data, mimeType: mimetype } = media;
  let sent: SentMessage;
  switch (media.kind) {
    case 'image':
      sent = await sock.sendMessage(jid, { image: data, caption, mimetype }, { messageId: botPictureId(sock) });
      break;
    case 'video':
      sent = await sock.sendMessage(jid, { video: data, caption, mimetype });
      break;
    case 'audio':
      return sock.sendMessage(jid, { audio: data, mimetype, ptt: media.voice ?? false });
    case 'document':
      sent = await sock.sendMessage(jid, {
        document: data,
        caption,
        mimetype,
        fileName: media.fileName ?? 'ملف',
      });
      break;
  }
  tellOwn(jid, sent?.key.id, caption, true, sock.user?.id);
  return sent;
}

/**
 * The WhatsApp address of a phone number, asked of the private number, or null
 * when the number has no WhatsApp. `digits` is the number with its country code.
 */
export async function privateNumberAddress(digits: string): Promise<string | null> {
  const found = await socketOf('private').onWhatsApp(`${digits}@s.whatsapp.net`);
  const match = found?.find((entry) => entry.exists);
  return match ? match.jid : null;
}

/** Sends a photo, with words under it, from the private number to a person. */
/**
 * Changes, for the customer too, a message the private number sent: new words,
 * or gone, as WhatsApp's own edit and delete-for-everyone do.
 */
export async function changePrivately(
  jid: string,
  waId: string,
  change: { text: string } | { delete: true },
): Promise<void> {
  const key = { remoteJid: jid, fromMe: true, id: waId };
  await socketOf('private').sendMessage(
    jid,
    'text' in change ? { text: change.text, edit: key } : { delete: key },
  );
}

/** A reaction from the private number on a message of a conversation; an empty emoji takes it off. */
export async function reactPrivately(jid: string, waId: string, fromMe: boolean, emoji: string): Promise<void> {
  await socketOf('private').sendMessage(jid, { react: { text: emoji, key: { remoteJid: jid, fromMe, id: waId } } });
}

export async function sendPrivateImage(
  jid: string,
  image: Buffer,
  mimetype: string,
  caption: string,
  quoted?: WAMessage,
): Promise<string | null> {
  const sent = await socketOf('private').sendMessage(
    jid,
    { image, mimetype, caption },
    quoted ? { quoted } : undefined,
  );
  return sent?.key.id ?? null;
}

/** Answers someone from the private number, showing it typing first as a person would. */
export async function replyPrivately(
  jid: string,
  text: string,
  quoted?: WAMessage,
): Promise<string | null> {
  const sock = socketOf('private');
  await sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, Math.min(3_500, 1_000 + text.length * 15)));
  await sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
  // WhatsApp not answering must end in an error someone sees, not a reply that never comes.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // WhatsApp's id for what was sent, so it can be quoted in turn.
    const sent = await Promise.race([
      sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('WhatsApp did not take the reply in time')), 45_000);
      }),
    ]);
    return sent?.key.id ?? null;
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
  const sock = await socketFor(jid);
  const sent = await sock.sendMessage(jid, { text }, quoted ? { quoted } : undefined);
  tellOwn(jid, sent?.key.id, text, false, sock.user?.id);
  return sent;
}

/**
 * Writes a message passed on from another group. Never told of in turn, so two
 * groups passing to each other do not send it back and forth.
 */
export async function sendPassedOn(jid: string, text: string): Promise<SentMessage> {
  const sent = await (await socketFor(jid)).sendMessage(jid, { text });
  // Its echo from the phone is known already, and is not passed on either.
  if (sent?.key.id) {
    firstSighting(shared.ownSeen, `${jid}:${sent.key.id}`);
    tellGroup({
      chat: jid,
      waId: sent.key.id,
      fromMe: true,
      name: null,
      phone: null,
      text,
      mediaKind: null,
      at: new Date(),
    });
  }
  return sent;
}

/** A photo passed on from another group, by hand or by a rule: never passed on again. */
export async function sendPassedOnImage(
  jid: string,
  image: Buffer,
  mimetype: string,
  caption: string,
): Promise<SentMessage> {
  const sent = await (await socketFor(jid)).sendMessage(jid, { image, caption, mimetype });
  if (sent?.key.id) {
    firstSighting(shared.ownSeen, `${jid}:${sent.key.id}`);
    tellGroup({
      chat: jid,
      waId: sent.key.id,
      fromMe: true,
      name: null,
      phone: null,
      text: caption,
      mediaKind: 'image',
      at: new Date(),
      download: async () => ({ bytes: image, mimeType: mimetype, fileName: null }),
    });
  }
  return sent;
}

/** Rewrites the words of a text message this office's number sent to a chat. */
export async function editSent(jid: string, messageId: string, text: string): Promise<void> {
  const sock = await socketFor(jid);
  await sock.sendMessage(jid, { text, edit: { remoteJid: jid, fromMe: true, id: messageId } });
}

/** A message this office's number sent, known only by its id, to answer by quoting it. */
export function sentStub(jid: string, messageId: string): WAMessage {
  return {
    key: { remoteJid: jid, fromMe: true, id: messageId },
    message: { conversation: '' },
  } as WAMessage;
}

/** Writes to a chat as a reply to a message this office's number sent there, known by its id. */
export async function replyToSent(
  jid: string,
  messageId: string,
  text: string,
): Promise<SentMessage> {
  const sock = await socketFor(jid);
  // The words quoted are not kept; WhatsApp shows the original by its id.
  const quoted = {
    key: { remoteJid: jid, fromMe: true, id: messageId },
    message: { conversation: '' },
  } as WAMessage;
  const sent = await sock.sendMessage(jid, { text }, { quoted });
  tellOwn(jid, sent?.key.id, text, false, sock.user?.id);
  return sent;
}

/**
 * Answers a message someone else wrote in a group, quoting it — with words, or
 * with a photo and words under it — and puts a reaction on it.
 */
export async function answerInGroup(
  jid: string,
  quote: { id: string; author: string | null; text: string },
  content: { text: string } | { image: Buffer; mimetype: string; caption: string },
  reaction?: string,
): Promise<SentMessage> {
  const sock = await socketFor(jid);
  const quoted = {
    key: { remoteJid: jid, fromMe: false, id: quote.id, participant: quote.author ?? undefined },
    message: { conversation: quote.text },
  } as WAMessage;
  const sent = await sock.sendMessage(
    jid,
    'text' in content
      ? { text: content.text }
      : { image: content.image, caption: content.caption, mimetype: content.mimetype },
    'text' in content ? { quoted } : { quoted, messageId: botPictureId(sock) },
  );
  if (reaction) {
    await sock
      .sendMessage(jid, {
        react: {
          text: reaction,
          key: { remoteJid: jid, fromMe: false, id: quote.id, participant: quote.author ?? undefined },
        },
      })
      .catch(() => undefined);
  }
  // Never passed on by the rules: it is the office's answer, not a deal.
  if (sent?.key.id) firstSighting(shared.ownSeen, `${jid}:${sent.key.id}`);
  return sent;
}

/**
 * Puts a reaction on any message of a group — the office's own or a member's,
 * who is named for WhatsApp to find it — or takes it off, with an empty emoji.
 */
export async function reactOn(
  jid: string,
  message: { id: string; fromMe: boolean; author: string | null },
  emoji: string,
): Promise<void> {
  const sock = await socketFor(jid);
  await sock.sendMessage(jid, {
    react: {
      text: emoji,
      key: {
        remoteJid: jid,
        fromMe: message.fromMe,
        id: message.id,
        ...(message.fromMe || !message.author ? {} : { participant: message.author }),
      },
    },
  });
}

/** Puts a reaction on a message this office's number sent to a chat. */
export async function reactTo(jid: string, messageId: string, emoji: string): Promise<void> {
  const sock = await socketFor(jid);
  await sock.sendMessage(jid, {
    react: { text: emoji, key: { remoteJid: jid, fromMe: true, id: messageId } },
  });
}
