import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { containsInsensitive } from '@/core/db/search';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';
import { keepMedia } from '@/modules/whatsapp/chat-images';
import {
  groups as whatsappGroups,
  onGroupSighting,
  sendPassedOn,
  sendPassedOnImage,
  deleteSent,
  reactOn,
  type GroupSighting,
} from '@/modules/whatsapp/whatsapp.service';
import type { Actor } from '@/modules/exchange/transaction.service';
import { transferChannels } from '@/modules/exchange/machine.service';
import { fromGroup } from './bank-request.service';
import { readTransferRequest } from './transfer-request';
import { parseRoutes } from '@/modules/whatsapp/group-routes';

const log = createLogger('bank:groups');

/**
 * The bank desk's view of its WhatsApp groups.
 *
 * The bot already sees every message in the groups it is in; this keeps those of
 * the groups the office chose to watch, for a fortnight or so, and every time one
 * is passed on — by a forwarding rule or by a person from the desk — so the desk
 * can follow where a transfer went without opening WhatsApp.
 */

export const WATCHED_SETTING = 'bank.watchedGroups';
export const RETENTION_SETTING = 'bank.groupRetentionDays';
export const EXECUTORS_SETTING = 'bank.executorGroups';

export interface WatchedGroup {
  id: string;
  name: string;
}

/** The groups the office chose to watch, as stored. Anything unreadable is none. */
export function parseWatched(raw: unknown): WatchedGroup[] {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw || '[]');
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is WatchedGroup =>
        Boolean(entry) &&
        typeof (entry as WatchedGroup).id === 'string' &&
        (entry as WatchedGroup).id.endsWith('@g.us'),
    )
    .map((entry) => ({ id: entry.id, name: String(entry.name ?? '').slice(0, 120) }));
}

/**
 * The bank transfers group: the one the WhatsApp settings send the deals'
 * transfers to. The desk's list is the transfers there, so it is always followed.
 */
export async function bankGroup(): Promise<WatchedGroup | null> {
  const route = parseRoutes(await settings.getString('whatsapp.groupRoutes')).BANK_COPY;
  return route?.id ? { id: route.id, name: route.name || 'تحويلات بنك' } : null;
}

export async function watched(): Promise<WatchedGroup[]> {
  const chosen = parseWatched(await settings.get(WATCHED_SETTING));
  const bank = await bankGroup();
  return bank && !chosen.some((group) => group.id === bank.id) ? [bank, ...chosen] : chosen;
}

/** Who may work the desk's view: whoever the settings name, or a manager. */
function requireDesk(actor: Actor) {
  if (
    !actor.permissions.includes('bank.execute') &&
    !actor.permissions.includes('exchange.transfer.confirm')
  ) {
    throw errors.forbidden('bank.execute');
  }
}

// ---------------------------------------------------------------------------
// Keeping what is seen
// ---------------------------------------------------------------------------

async function keep(sighting: GroupSighting): Promise<void> {
  const groups = await watched();
  if (!groups.some((group) => group.id === sighting.chat)) return;

  // A file only for what the desk would open: photos and documents, not voice or video.
  let mediaId: string | null = null;
  if (sighting.download && (sighting.mediaKind === 'image' || sighting.mediaKind === 'document')) {
    const file = await sighting.download().catch(() => null);
    if (file) mediaId = (await keepMedia(file, null))?.id ?? null;
  }

  await prisma.groupMessage
    .create({
      data: {
        chat: sighting.chat,
        waId: sighting.waId,
        fromMe: sighting.fromMe,
        senderName: sighting.name?.slice(0, 120) ?? null,
        senderPhone: sighting.phone?.split('@')[0] ?? null,
        senderJid: sighting.author ?? null,
        text: sighting.text.slice(0, 4000),
        mediaId,
        mediaKind: sighting.mediaKind,
        createdAt: sighting.at,
      },
    })
    // Seen twice — by both numbers, or by the phone and the app — it is kept once.
    .catch((error: { code?: string }) => {
      if (error?.code !== 'P2002') throw error;
    });

  // Someone else asking for a transfer: read for the desk's list. The office's own are deals already.
  if (!sighting.fromMe && sighting.text.trim()) {
    await fromGroup({
      chat: sighting.chat,
      waId: sighting.waId,
      senderJid: sighting.author ?? null,
      senderName: sighting.name,
      senderPhone: sighting.phone?.split('@')[0] ?? null,
      text: sighting.text,
    }).catch((error) => log.warn('Could not read a transfer request', { error }));
  }
}

/** What was older than the office keeps, with the files only it held. */
export async function sweep(): Promise<number> {
  const days = Math.max(1, await settings.getNumber(RETENTION_SETTING));
  const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const old = await prisma.groupMessage.findMany({
    where: { createdAt: { lt: before } },
    select: { id: true, mediaId: true },
    take: 2000,
  });
  if (old.length === 0) return 0;
  const media = old.map((row) => row.mediaId).filter((id): id is string => Boolean(id));
  await prisma.$transaction([
    prisma.groupMessage.deleteMany({ where: { id: { in: old.map((row) => row.id) } } }),
    prisma.chatImage.deleteMany({ where: { id: { in: media } } }),
    prisma.groupForward.deleteMany({ where: { createdAt: { lt: before } } }),
  ]);
  return old.length;
}

/** A message passed on, by a rule or by hand. */
export async function recordForward(input: {
  sourceChat: string;
  sourceWaId: string | null | undefined;
  targetChat: string;
  targetName?: string | null;
  targetWaId?: string | null;
  auto: boolean;
  byUserId?: string | null;
  byName?: string | null;
}): Promise<void> {
  if (!input.sourceWaId) return;
  const groups = await watched();
  // Only where the desk looks: from a watched group, or into one.
  if (!groups.some((group) => group.id === input.sourceChat || group.id === input.targetChat)) {
    return;
  }
  await prisma.groupForward.create({
    data: {
      sourceChat: input.sourceChat,
      sourceWaId: input.sourceWaId,
      targetChat: input.targetChat,
      targetName:
        input.targetName ?? groups.find((group) => group.id === input.targetChat)?.name ?? null,
      targetWaId: input.targetWaId ?? null,
      auto: input.auto,
      byUserId: input.byUserId ?? null,
      byName: input.byName ?? null,
    },
  });
}

let registered = false;

/** Listens to the groups for the desk. Once per process. */
export function registerGroupFeed(): void {
  if (registered) return;
  registered = true;
  onGroupSighting((sighting) =>
    keep(sighting).catch((error) => log.warn('Could not keep a group message', { error })),
  );
  // Hourly, so a busy group never grows the database past what the office keeps.
  const timer = setInterval(
    () => void sweep().catch((error) => log.warn('Could not clear old group messages', { error })),
    60 * 60 * 1000,
  );
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The groups watched, for the desk's tabs. */
export async function feedGroups(actor: Actor) {
  requireDesk(actor);
  return {
    groups: await watched(),
    canChoose: actor.permissions.includes('settings.manage'),
    // The banks a request added by hand may name.
    channels: await transferChannels(),
  };
}

/** The office chooses which groups the desk sees. */
export async function setWatched(groups: WatchedGroup[], actor: Actor & { name: string }) {
  if (!actor.permissions.includes('settings.manage')) throw errors.forbidden('settings.manage');
  const clean = parseWatched(groups).slice(0, 10);
  await settings.set(WATCHED_SETTING, clean, actor);
  return clean;
}

/** The groups that carry the transfers out, as the manager chose them. */
export async function executorGroups(): Promise<WatchedGroup[]> {
  return parseWatched(await settings.get(EXECUTORS_SETTING));
}

/** The executing groups for the desk, and whether this person may change them. */
export async function executorsFor(actor: Actor) {
  requireDesk(actor);
  return {
    groups: await executorGroups(),
    // Whoever works the desk pins them: the person sending transfers knows where they go.
    canChoose: true,
  };
}

/** The desk, or the manager, pins the groups transfers are passed on to. */
export async function setExecutors(groups: WatchedGroup[], actor: Actor & { name: string }) {
  requireDesk(actor);
  const clean = parseWatched(groups).slice(0, 20);
  await settings.set(EXECUTORS_SETTING, clean, actor);
  return clean;
}

/** Every group the linked numbers are in, to choose from or to forward to. */
export async function allGroups(actor: Actor) {
  requireDesk(actor);
  return (await whatsappGroups()).map((group) => ({ id: group.id, name: group.name }));
}

/**
 * A watched group's latest messages, oldest first, each with the deal it is the
 * message of and where it was passed on to or from.
 */
export async function feed(chat: string, actor: Actor, search?: string | null) {
  requireDesk(actor);
  const groups = await watched();
  if (!groups.some((group) => group.id === chat)) throw errors.notFound('Group', chat);

  const rows = (
    await prisma.groupMessage.findMany({
      // Searched across everything kept, not only the latest shown.
      where: {
        chat,
        ...(search?.trim()
          ? {
              OR: [
                { text: containsInsensitive(search.trim()) },
                { senderName: containsInsensitive(search.trim()) },
                { senderPhone: { contains: search.trim().replace(/\D/g, '') || search.trim() } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 150,
    })
  ).reverse();
  const ids = rows.map((row) => row.waId);

  const [requests, channels] = await Promise.all([
    prisma.bankRequest.findMany({
      where: { chat, waId: { in: ids } },
      select: { id: true, waId: true, status: true },
    }),
    transferChannels(),
  ]);
  const [deals, outgoing, incoming] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        OR: [
          { announcedChat: chat, announcedMessageId: { in: ids } },
          { copyChat: chat, copyMessageId: { in: ids } },
        ],
      },
      select: {
        id: true,
        reference: true,
        status: true,
        type: true,
        transferConfirmedAt: true,
        announcedMessageId: true,
        copyMessageId: true,
        announcedChat: true,
        copyChat: true,
      },
    }),
    prisma.groupForward.findMany({
      where: { sourceChat: chat, sourceWaId: { in: ids } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.groupForward.findMany({
      where: { targetChat: chat, targetWaId: { in: ids } },
    }),
  ]);
  const nameOf = (id: string) => groups.find((group) => group.id === id)?.name ?? null;

  return rows.map((row) => {
    const deal = deals.find(
      (entry) =>
        (entry.announcedChat === chat && entry.announcedMessageId === row.waId) ||
        (entry.copyChat === chat && entry.copyMessageId === row.waId),
    );
    const from = incoming.find((entry) => entry.targetWaId === row.waId);
    return {
      id: row.id,
      fromMe: row.fromMe,
      senderName: row.senderName,
      senderPhone: row.senderPhone,
      text: row.text,
      mediaId: row.mediaId,
      mediaKind: row.mediaKind,
      at: row.createdAt,
      deal: deal
        ? {
            id: deal.id,
            reference: deal.reference,
            status: deal.status,
            sent: Boolean(deal.transferConfirmedAt),
          }
        : null,
      forwardedTo: outgoing
        .filter((entry) => entry.sourceWaId === row.waId)
        .map((entry) => ({
          group: entry.targetName ?? nameOf(entry.targetChat) ?? entry.targetChat,
          auto: entry.auto,
          by: entry.byName,
          at: entry.createdAt,
        })),
      // In the desk's list, or what the bot would put there were it added.
      request: (() => {
        const found = requests.find((entry) => entry.waId === row.waId);
        return found ? { id: found.id, status: found.status } : null;
      })(),
      suggested:
        !row.fromMe && !requests.some((entry) => entry.waId === row.waId)
          ? (() => {
              const read = readTransferRequest(row.text, channels);
              return read ? { ...read, amount: read.amount.toString() } : null;
            })()
          : null,
      forwardedFrom: from
        ? {
            group: nameOf(from.sourceChat) ?? from.sourceChat,
            auto: from.auto,
            by: from.byName,
          }
        : null,
    };
  });
}

/**
 * A message's way through the groups, for following it: who wrote it where and
 * when; if it is a copy, the message it was passed on from, and that one's own
 * origin, back to whoever first wrote it; every group it was passed on to, by a
 * rule or by whom, and the copy that arrived; the deal it announces; and the
 * request it became in the desk's list, and how far that got.
 */
export async function trace(messageId: string, actor: Actor) {
  requireDesk(actor);
  const groups = await watched();
  const nameOf = (chat: string) => groups.find((group) => group.id === chat)?.name ?? chat;
  const message = await prisma.groupMessage.findUnique({ where: { id: messageId } });
  if (!message) throw errors.notFound('GroupMessage', messageId);

  const point = (row: typeof message) => ({
    id: row.id,
    group: nameOf(row.chat),
    fromMe: row.fromMe,
    senderName: row.senderName,
    senderPhone: row.senderPhone,
    text: row.text,
    mediaId: row.mediaId,
    mediaKind: row.mediaKind,
    at: row.createdAt,
  });

  // Back to where it began: each copy's forward names the message it was passed on from.
  const origins: (ReturnType<typeof point> & { how: { auto: boolean; by: string | null; at: Date } })[] = [];
  let current = message;
  for (let step = 0; step < 6; step += 1) {
    const forward = await prisma.groupForward.findFirst({
      where: { targetChat: current.chat, targetWaId: current.waId },
    });
    if (!forward) break;
    const source = await prisma.groupMessage.findUnique({
      where: { chat_waId: { chat: forward.sourceChat, waId: forward.sourceWaId } },
    });
    const how = { auto: forward.auto, by: forward.byName, at: forward.createdAt };
    if (!source) {
      origins.unshift({
        id: '',
        group: nameOf(forward.sourceChat),
        fromMe: false,
        senderName: null,
        senderPhone: null,
        text: '',
        mediaId: null,
        mediaKind: null,
        at: forward.createdAt,
        how,
      });
      break;
    }
    origins.unshift({ ...point(source), how });
    current = source;
  }

  // Where it went from here, and the copy that arrived there when the desk follows that group.
  const forwards = await prisma.groupForward.findMany({
    where: { sourceChat: message.chat, sourceWaId: message.waId },
    orderBy: { createdAt: 'asc' },
  });
  const copies = await prisma.groupMessage.findMany({
    where: {
      OR: forwards
        .filter((forward) => forward.targetWaId)
        .map((forward) => ({ chat: forward.targetChat, waId: forward.targetWaId! })),
    },
    select: { id: true, chat: true, waId: true },
  });

  const [deal, request] = await Promise.all([
    prisma.transaction.findFirst({
      where: {
        OR: [
          { announcedChat: message.chat, announcedMessageId: message.waId },
          { copyChat: message.chat, copyMessageId: message.waId },
        ],
      },
      select: {
        id: true,
        reference: true,
        status: true,
        transferConfirmedAt: true,
        transferConfirmedBy: { select: { fullNameAr: true } },
        createdBy: { select: { fullNameAr: true } },
      },
    }),
    prisma.bankRequest.findUnique({
      where: { chat_waId: { chat: message.chat, waId: message.waId } },
      select: { id: true, status: true, auto: true, addedByName: true, sentAt: true, sentByName: true, createdAt: true },
    }),
  ]);
  const channels = await transferChannels();

  const suggested =
    !message.fromMe && !deal && (!request || request.status === 'DISMISSED')
      ? (() => {
          const read = readTransferRequest(message.text, channels);
          return read ? { ...read, amount: read.amount.toString() } : null;
        })()
      : null;

  return {
    message: point(message),
    suggested,
    origins,
    forwards: forwards.map((forward) => ({
      group: forward.targetName ?? nameOf(forward.targetChat),
      auto: forward.auto,
      by: forward.byName,
      at: forward.createdAt,
      copyId:
        copies.find((copy) => copy.chat === forward.targetChat && copy.waId === forward.targetWaId)?.id ?? null,
      delivered: Boolean(forward.targetWaId),
    })),
    deal: deal
      ? {
          id: deal.id,
          reference: deal.reference,
          status: deal.status,
          by: deal.createdBy?.fullNameAr ?? null,
          sentAt: deal.transferConfirmedAt,
          sentBy: deal.transferConfirmedBy?.fullNameAr ?? null,
        }
      : null,
    request,
  };
}

/** A kept file, to the desk. */
export async function media(id: string, actor: Actor) {
  requireDesk(actor);
  const row = await prisma.chatImage.findUnique({ where: { id } });
  /*
   * Only the desk's files: a group message's, or a transfer's receipt — given
   * at the desk, or answered in a group. The inbox's own files are not the desk's.
   */
  const owned = row
    ? (
        await Promise.all([
          prisma.groupMessage.count({ where: { mediaId: id } }),
          prisma.transferReceipt.count({ where: { imageId: id } }),
          prisma.groupReply.count({ where: { mediaId: id } }),
          prisma.bankRequest.count({ where: { receiptId: id } }),
          prisma.tiktokWithdrawal.count({ where: { receiptId: id } }),
        ])
      ).some((count) => count > 0)
    : false;
  if (!row || !owned) throw errors.notFound('ChatImage', id);
  return row;
}

// ---------------------------------------------------------------------------
// Passing a message on by hand
// ---------------------------------------------------------------------------

/**
 * A message passed on from the desk to one group or several, by the bot, with
 * its words as the person left them and its photo when it had one.
 */
export async function forwardByHand(
  messageId: string,
  input: { targets: WatchedGroup[]; text: string; withPhoto?: boolean },
  actor: Actor & { name: string },
) {
  requireDesk(actor);
  const message = await prisma.groupMessage.findUnique({ where: { id: messageId } });
  if (!message) throw errors.notFound('GroupMessage', messageId);
  const targets = input.targets.filter((target) => target.id.endsWith('@g.us') && target.id !== message.chat);
  if (targets.length === 0) {
    throw errors.validation([{ path: 'targets', message: 'Choose a group' }]);
  }
  const text = input.text.trim().slice(0, 4000);
  const photo =
    input.withPhoto !== false && message.mediaId && message.mediaKind === 'image'
      ? await prisma.chatImage.findUnique({ where: { id: message.mediaId } })
      : null;
  if (!text && !photo) throw errors.validation([{ path: 'text', message: 'Nothing to send' }]);

  const done: string[] = [];
  for (const target of targets) {
    try {
      const sent = photo
        ? await sendPassedOnImage(target.id, Buffer.from(photo.data), photo.mimeType, text)
        : await sendPassedOn(target.id, text);
      await recordForward({
        sourceChat: message.chat,
        sourceWaId: message.waId,
        targetChat: target.id,
        targetName: target.name,
        targetWaId: sent?.key?.id ?? null,
        auto: false,
        byUserId: actor.id,
        byName: actor.name,
      });
      done.push(target.name || target.id);
    } catch (error) {
      log.warn('Could not pass a group message on by hand', { error });
    }
  }
  if (done.length === 0) {
    throw errors.precondition('WhatsApp did not take the message', 'errors.inboxSendFailed');
  }
  // Marked in its own group as passed on, as a person would mark it: a red heart.
  await reactOn(message.chat, { id: message.waId, fromMe: message.fromMe, author: message.senderJid }, '❤️').catch(
    (error) => log.warn('Could not mark a forwarded message with a heart', { error }),
  );
  log.info('A group message was passed on by hand', { count: done.length });
  return { sent: done };
}

/**
 * A transfer's forward taken back: it waits again, as though it had never been
 * passed on. Every forward the desk counts goes — by hand from the desk, by a
 * ❤️, found forwarded on WhatsApp, or by a rule to a group that carries
 * transfers out — and, when asked, the copies the office's number wrote there
 * are deleted for everyone. A copy a person forwarded from their own phone is
 * theirs; it cannot be deleted from here.
 */
export async function unforward(messageId: string, deleteCopies: boolean, actor: Actor & { name: string }) {
  requireDesk(actor);
  const message = await prisma.groupMessage.findUnique({ where: { id: messageId } });
  if (!message) throw errors.notFound('GroupMessage', messageId);
  const executors = await executorGroups();
  const forwards = await prisma.groupForward.findMany({
    where: {
      sourceChat: message.chat,
      sourceWaId: message.waId,
      OR: [{ auto: false }, { targetChat: { in: executors.map((group) => group.id) } }],
    },
  });
  let deleted = 0;
  if (deleteCopies) {
    for (const entry of forwards) {
      // The office's own copies: sent by the desk, or by a rule. Not a reaction, nor a person's forward.
      const ours = Boolean(entry.targetWaId) && !entry.reactor && (entry.auto || Boolean(entry.byUserId));
      if (!ours) continue;
      try {
        await deleteSent(entry.targetChat, entry.targetWaId!);
        deleted += 1;
      } catch (error) {
        log.warn('Could not delete a forwarded copy', { error });
      }
    }
  }
  await prisma.groupForward.deleteMany({ where: { id: { in: forwards.map((entry) => entry.id) } } });
  // The heart taken off with it: it waits again.
  await reactOn(message.chat, { id: message.waId, fromMe: message.fromMe, author: message.senderJid }, '').catch(
    (error) => log.warn('Could not take a forwarded message’s heart off', { error }),
  );
  log.info('A forward was taken back', { forwards: forwards.length, deleted });
  return { removed: forwards.length, deleted };
}
