import 'server-only';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { clearSession, databaseAuthState, hasSession } from './auth-state';

/**
 * The office's WhatsApp number, linked the way WhatsApp Web is: the manager
 * opens the settings, a QR code appears, and the phone that holds the number
 * scans it from «الأجهزة المرتبطة». From then on the server is one of that
 * number's linked devices and can write to the groups it is in.
 *
 * One connection for the whole server, kept on `globalThis` so the route
 * bundles Next.js builds separately all reach the same one. It resumes by
 * itself when the server starts with a session already saved, and reconnects
 * after a dropped line; only an unlink from the phone ends it for good.
 *
 * Not WhatsApp's official API — that one cannot write to groups. Which is why
 * the number should be one kept for the system, not somebody's own.
 */

const log = createLogger('whatsapp');

export type LinkStatus = 'OFF' | 'CONNECTING' | 'WAITING_QR' | 'CONNECTED';

interface Holder {
  sock: WASocket | null;
  status: LinkStatus;
  qr: string | null;
  me: { id: string; name: string | null } | null;
  error: string | null;
  retry: ReturnType<typeof setTimeout> | null;
  /** Bumped whenever a socket is replaced, so a stale one's events are ignored. */
  generation: number;
  /** Who is told of a message arriving — kept here so a reconnect keeps them. */
  listeners?: Listener[];
}

/** A text message someone else wrote, in a chat the linked number is in. */
export interface IncomingText {
  chat: string;
  text: string;
  /** The sender as WhatsApp addressed them — a phone JID, or an anonymous @lid. */
  sender: string | null;
  /** Their phone JID when WhatsApp said it outright. */
  senderPhone: string | null;
  message: WAMessage;
}

type Listener = (incoming: IncomingText) => Promise<void> | void;

const globalForWhatsapp = globalThis as unknown as { __ifmsWhatsapp?: Holder };
const holder: Holder = (globalForWhatsapp.__ifmsWhatsapp ??= {
  sock: null,
  status: 'OFF',
  qr: null,
  me: null,
  error: null,
  retry: null,
  generation: 0,
});

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
    log.error(msg ?? 'baileys', { detail: obj });
  },
};

async function open(): Promise<void> {
  const generation = ++holder.generation;
  holder.status = 'CONNECTING';
  holder.error = null;

  const { state, saveCreds } = await databaseAuthState();
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
   * Messages as they arrive — "notify", not the history WhatsApp replays on
   * connecting, so a command typed while the server was down is not answered
   * hours later. The bot's own messages are never read back.
   */
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (generation !== holder.generation || type !== 'notify') return;
    for (const message of messages) {
      if (message.key.fromMe || !message.key.remoteJid) continue;
      const content = normalizeMessageContent(message.message);
      const text = content?.conversation ?? content?.extendedTextMessage?.text ?? null;
      if (!text) continue;
      const sender = message.key.participant ?? message.key.remoteJid;
      const phone =
        message.key.participantPn ??
        message.key.senderPn ??
        (sender?.endsWith('@s.whatsapp.net') ? sender : null);
      const incoming: IncomingText = {
        chat: message.key.remoteJid,
        text,
        sender: sender ?? null,
        senderPhone: phone ?? null,
        message,
      };
      for (const listener of holder.listeners ?? []) {
        void Promise.resolve()
          .then(() => listener(incoming))
          .catch((error) => log.error('A WhatsApp message handler failed', { error }));
      }
    }
  });

  sock.ev.on('creds.update', () => {
    void saveCreds().catch((error) => log.error('Could not save the session', { error }));
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
      log.info('WhatsApp linked', { id: holder.me?.id });
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
        holder.error = 'loggedOut';
        void clearSession().catch(() => undefined);
        log.warn('WhatsApp was unlinked from the phone');
        return;
      }

      if (code === DisconnectReason.restartRequired) {
        // Normal straight after scanning: the phone asks for a fresh connection.
        void open().catch((error) => fail(error));
        return;
      }

      // A QR nobody scanned in time ends the attempt; anything else is a dropped line.
      void hasSession().then((linked) => {
        if (generation !== holder.generation) return;
        if (!linked) {
          holder.status = 'OFF';
          holder.error = 'qrExpired';
          return;
        }
        holder.status = 'CONNECTING';
        holder.retry = setTimeout(() => {
          holder.retry = null;
          void open().catch((error) => fail(error));
        }, 5_000);
      });
    }
  });
}

function fail(error: unknown) {
  holder.status = 'OFF';
  holder.error = 'failed';
  log.error('WhatsApp connection failed', { error });
}

/** Starts linking: shows a QR when no number is linked, or resumes the one that is. */
export async function connect(): Promise<void> {
  if (
    holder.status === 'CONNECTED' ||
    holder.status === 'CONNECTING' ||
    holder.status === 'WAITING_QR'
  ) {
    return;
  }
  if (holder.retry) clearTimeout(holder.retry);
  holder.retry = null;
  await open();
}

/** At server start: resumes a linked number, and does nothing when none is. */
export async function resume(): Promise<void> {
  if (holder.sock || holder.status !== 'OFF') return;
  if (!(await hasSession())) return;
  await open();
}

/** Unlinks the number: off the phone's linked devices, and out of the database. */
export async function disconnect(): Promise<void> {
  holder.generation += 1;
  if (holder.retry) clearTimeout(holder.retry);
  holder.retry = null;
  const sock = holder.sock;
  holder.sock = null;
  holder.status = 'OFF';
  holder.qr = null;
  holder.me = null;
  holder.error = null;
  if (sock) {
    await sock.logout().catch(() => sock.end(undefined));
  }
  await clearSession();
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

export async function snapshot(): Promise<LinkSnapshot> {
  return {
    status: holder.status,
    qrImage: holder.qr ? await QRCode.toDataURL(holder.qr, { margin: 1, width: 280 }) : null,
    number: holder.me ? holder.me.id.split(':')[0]!.split('@')[0]! : null,
    name: holder.me?.name ?? null,
    error: holder.error,
  };
}

function linked(): WASocket {
  if (holder.status !== 'CONNECTED' || !holder.sock) {
    throw errors.precondition('WhatsApp is not linked', 'errors.whatsappNotLinked');
  }
  return holder.sock;
}

/** The groups the linked number is in, by name. */
export async function groups(): Promise<{ id: string; name: string; size: number }[]> {
  const all = await linked().groupFetchAllParticipating();
  return Object.values(all)
    .map((group) => ({ id: group.id, name: group.subject, size: group.participants.length }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
}

/** Sends a picture, with a line under it, optionally as a reply. */
export async function sendImage(
  jid: string,
  image: Buffer,
  caption: string,
  quoted?: WAMessage,
): Promise<SentMessage> {
  return linked().sendMessage(
    jid,
    { image, caption, mimetype: 'image/png' },
    quoted ? { quoted } : undefined,
  );
}

/** Tells `listener` of every text message others write where the number is. */
export function onIncomingText(listener: Listener): void {
  (holder.listeners ??= []).push(listener);
}

/**
 * A group member's phone JID, when WhatsApp hid it behind an anonymous @lid —
 * which it now does in many groups. The group's own member list pairs the two.
 */
export async function memberPhone(group: string, member: string): Promise<string | null> {
  if (member.endsWith('@s.whatsapp.net')) return member;
  const metadata = await linked().groupMetadata(group);
  const found = metadata.participants.find(
    (participant) => participant.id === member || participant.lid === member,
  );
  if (found?.jid) return found.jid;
  return found?.id.endsWith('@s.whatsapp.net') ? found.id : null;
}

export function isLinked(): boolean {
  return holder.status === 'CONNECTED' && holder.sock !== null;
}

export type SentMessage = Awaited<ReturnType<WASocket['sendMessage']>>;

/**
 * Writes to a chat, optionally as a reply to a message already in it, and
 * hands back what was sent so a reply can be made to it in turn.
 */
export async function sendText(
  jid: string,
  text: string,
  quoted?: WAMessage,
): Promise<SentMessage> {
  return linked().sendMessage(jid, { text }, quoted ? { quoted } : undefined);
}
