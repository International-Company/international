import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';
import { keepMedia } from '@/modules/whatsapp/chat-images';
import {
  groups as whatsappGroups,
  onGroupSighting,
  sendPassedOn,
  sendPassedOnImage,
  type GroupSighting,
} from '@/modules/whatsapp/whatsapp.service';
import type { Actor } from '@/modules/exchange/transaction.service';

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

export async function watched(): Promise<WatchedGroup[]> {
  return parseWatched(await settings.get(WATCHED_SETTING));
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
  };
}

/** The office chooses which groups the desk sees. */
export async function setWatched(groups: WatchedGroup[], actor: Actor & { name: string }) {
  if (!actor.permissions.includes('settings.manage')) throw errors.forbidden('settings.manage');
  const clean = parseWatched(groups).slice(0, 10);
  await settings.set(WATCHED_SETTING, clean, actor);
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
export async function feed(chat: string, actor: Actor) {
  requireDesk(actor);
  const groups = await watched();
  if (!groups.some((group) => group.id === chat)) throw errors.notFound('Group', chat);

  const rows = (
    await prisma.groupMessage.findMany({
      where: { chat },
      orderBy: { createdAt: 'desc' },
      take: 150,
    })
  ).reverse();
  const ids = rows.map((row) => row.waId);

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

/** A kept file, to the desk. */
export async function media(id: string, actor: Actor) {
  requireDesk(actor);
  const row = await prisma.chatImage.findUnique({ where: { id } });
  // Only a file of a group message: the inbox's own files are not the desk's.
  const owned = row ? await prisma.groupMessage.count({ where: { mediaId: id } }) : 0;
  if (!row || owned === 0) throw errors.notFound('ChatImage', id);
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
  input: { targets: WatchedGroup[]; text: string },
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
    message.mediaId && message.mediaKind === 'image'
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
  log.info('A group message was passed on by hand', { count: done.length });
  return { sent: done };
}
