import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { changesAllowed } from './message-change';
import { customerNames, shownName } from './chat-names';

/**
 * What the private number keeps: each person's conversation, and the requests
 * they made of the office. Kept so the manager can read what was said and who
 * is following up; removed after the period set on the panel.
 */

export const REQUEST_STATUSES = ['NEW', 'IN_PROGRESS', 'DONE'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export type MessageRole = 'customer' | 'bot' | 'staff';

const digitsOf = (jid: string | null) => {
  if (!jid?.endsWith('@s.whatsapp.net')) return null;
  return jid.split('@')[0]!.split(':')[0]!;
};

async function conversationFor(chat: string, phoneJid: string | null) {
  const phone = digitsOf(phoneJid) ?? digitsOf(chat);
  const found = await prisma.botConversation.findFirst({
    where: { OR: [{ chat }, ...(phone ? [{ phone }] : [])] },
  });
  if (found) {
    return found.phone || !phone
      ? found
      : prisma.botConversation.update({ where: { id: found.id }, data: { phone } });
  }
  return prisma.botConversation.create({ data: { chat, phone, lastMessageAt: new Date() } });
}

/** What else is known of a message beyond its words. */
export interface MessageExtra {
  /** Who of the staff wrote it from the system. */
  authorName?: string | null;
  /** A file that came with it, and what kind. */
  mediaId?: string | null;
  mediaKind?: string | null;
  /** WhatsApp's id for it, and of the message it quotes. */
  waId?: string | null;
  quotedWaId?: string | null;
  /** The name the customer goes by on WhatsApp. */
  name?: string | null;
}

export async function recordMessage(
  chat: string,
  phoneJid: string | null,
  role: MessageRole,
  text: string,
  extra: MessageExtra = {},
): Promise<void> {
  const conversation = await conversationFor(chat, phoneJid);
  const quoted = extra.quotedWaId
    ? await prisma.botMessage.findFirst({
        where: { conversationId: conversation.id, waId: extra.quotedWaId },
        select: { id: true },
      })
    : null;
  const customer = role === 'customer';
  await prisma.$transaction([
    prisma.botMessage.create({
      data: {
        conversationId: conversation.id,
        role,
        text: text.slice(0, 2000),
        authorName: extra.authorName ?? null,
        imageId: extra.mediaId ?? null,
        mediaKind: extra.mediaKind ?? null,
        waId: extra.waId ?? null,
        quotedId: quoted?.id ?? null,
      },
    }),
    prisma.botConversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        ...(customer ? { unread: { increment: 1 } } : {}),
        ...(customer && extra.name?.trim() ? { name: extra.name.trim().slice(0, 80) } : {}),
      },
    }),
  ]);
}

/** Staff have opened it: nothing in it is unread any more. */
export async function markSeen(id: string): Promise<void> {
  await prisma.botConversation.updateMany({
    where: { id, unread: { gt: 0 } },
    data: { unread: 0 },
  });
}

/** How many customer messages on the private number nobody has opened yet. */
export async function unreadCount(): Promise<number> {
  const total = await prisma.botConversation.aggregate({ _sum: { unread: true } });
  return total._sum.unread ?? 0;
}

/**
 * One person can have a conversation under their number and another under a
 * hidden (@lid) address; a pause on either is a pause on both.
 */
const samePerson = (chat: string, phoneJid: string | null) => {
  const phone = digitsOf(phoneJid) ?? digitsOf(chat);
  return { OR: [{ chat }, ...(phone ? [{ phone }] : [])] };
};

export async function isPaused(chat: string, phoneJid: string | null): Promise<boolean> {
  await conversationFor(chat, phoneJid);
  const paused = await prisma.botConversation.count({
    where: { AND: [samePerson(chat, phoneJid), { pausedUntil: { gt: new Date() } }] },
  });
  return paused > 0;
}

/** A member of staff has taken this conversation: the bot keeps out of it until then. */
export async function pauseChat(
  chat: string,
  phoneJid: string | null,
  minutes: number,
): Promise<void> {
  await conversationFor(chat, phoneJid);
  await prisma.botConversation.updateMany({
    where: samePerson(chat, phoneJid),
    data: { pausedUntil: new Date(Date.now() + minutes * 60_000) },
  });
}

export async function raiseRequest(
  chat: string,
  phoneJid: string | null,
  summary: string,
): Promise<void> {
  const conversation = await conversationFor(chat, phoneJid);
  await prisma.botRequest.create({ data: { conversationId: conversation.id, summary } });
}

/** Clears what has passed the period kept. Everything of a quiet conversation goes with it. */
export async function pruneOlderThan(days: number): Promise<void> {
  const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await prisma.botConversation.deleteMany({ where: { lastMessageAt: { lt: before } } });
  await prisma.botMessage.deleteMany({ where: { createdAt: { lt: before } } });
}

export async function listRequests() {
  const rows = await prisma.botRequest.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { conversation: { select: { id: true, phone: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    summary: row.summary,
    status: row.status,
    handledByName: row.handledByName,
    createdAt: row.createdAt,
    phone: row.conversation.phone,
    conversationId: row.conversation.id,
  }));
}

export async function setRequestStatus(
  id: string,
  status: RequestStatus,
  actor: { id: string; name: string },
): Promise<void> {
  const row = await prisma.botRequest.findUnique({ where: { id }, select: { id: true } });
  if (!row) throw errors.notFound('BotRequest', id);
  await prisma.botRequest.update({
    where: { id },
    data: { status, handledByName: status === 'NEW' ? null : actor.name },
  });
}

export async function listConversations() {
  const rows = await prisma.botConversation.findMany({
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { text: true, role: true, imageId: true, mediaKind: true, deletedAt: true },
      },
    },
  });
  const now = new Date();
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
    // The customer spoke last: nobody, person or bot, has answered yet.
    awaiting: row.messages[0]?.role === 'customer',
    paused: Boolean(row.pausedUntil && row.pausedUntil > now),
  }));
}

export async function readConversation(id: string) {
  const row = await prisma.botConversation.findUnique({
    where: { id },
    include: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: {
          id: true,
          role: true,
          text: true,
          authorName: true,
          imageId: true,
          mediaKind: true,
          waId: true,
          quotedId: true,
          editedAt: true,
          deletedAt: true,
          createdAt: true,
        },
      },
    },
  });
  if (!row) throw errors.notFound('BotConversation', id);
  const now = Date.now();
  const records = await customerNames([row.phone]);
  return {
    id: row.id,
    chat: row.chat,
    phone: row.phone,
    name: shownName(row.phone, row.name, records),
    pausedUntil: row.pausedUntil,
    messages: row.messages
      .reverse()
      .map(({ waId, imageId, mediaKind, editedAt, deletedAt, ...message }) => {
        const kind = mediaKind ?? (imageId ? 'image' : null);
        return {
          ...message,
          // Deleted for the customer: here only that it was, not what it said.
          text: deletedAt ? '' : message.text,
          // Kept before the kind was: every file then was a photo.
          imageId: deletedAt ? null : imageId,
          mediaKind: deletedAt ? null : kind,
          // Only a message WhatsApp knows by an id can be answered by quoting it.
          quotable: Boolean(waId) && !deletedAt,
          edited: Boolean(editedAt),
          deleted: Boolean(deletedAt),
          ...changesAllowed(
            {
              ours: message.role !== 'customer',
              waId,
              mediaKind: kind,
              deletedAt,
              createdAt: message.createdAt,
            },
            now,
          ),
        };
      }),
  };
}

/** The manager handing a conversation to, or taking it from, the bot. */
export async function setPaused(id: string, minutes: number | null): Promise<void> {
  const row = await prisma.botConversation.findUnique({
    where: { id },
    select: { phone: true },
  });
  if (!row) throw errors.notFound('BotConversation', id);
  await prisma.botConversation.updateMany({
    where: { OR: [{ id }, ...(row.phone ? [{ phone: row.phone }] : [])] },
    data: { pausedUntil: minutes ? new Date(Date.now() + minutes * 60_000) : null },
  });
}

/** A line for the list when the last message was a file without words. */
export function mediaMark(kind: string | null | undefined, mediaId?: string | null): string {
  switch (kind ?? (mediaId ? 'image' : null)) {
    case 'image':
      return '📷';
    case 'audio':
      return '🎤';
    case 'video':
      return '🎬';
    case 'document':
      return '📄';
    default:
      return '';
  }
}
