import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';

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

export async function recordMessage(
  chat: string,
  phoneJid: string | null,
  role: MessageRole,
  text: string,
): Promise<void> {
  const conversation = await conversationFor(chat, phoneJid);
  await prisma.$transaction([
    prisma.botMessage.create({
      data: { conversationId: conversation.id, role, text: text.slice(0, 2000) },
    }),
    prisma.botConversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    }),
  ]);
}

export async function isPaused(chat: string, phoneJid: string | null): Promise<boolean> {
  const conversation = await conversationFor(chat, phoneJid);
  return Boolean(conversation.pausedUntil && conversation.pausedUntil > new Date());
}

/** A member of staff has taken this conversation: the bot keeps out of it until then. */
export async function pauseChat(
  chat: string,
  phoneJid: string | null,
  minutes: number,
): Promise<void> {
  const conversation = await conversationFor(chat, phoneJid);
  await prisma.botConversation.update({
    where: { id: conversation.id },
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
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { text: true } } },
  });
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    phone: row.phone,
    lastMessageAt: row.lastMessageAt,
    lastText: row.messages[0]?.text ?? '',
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
        select: { id: true, role: true, text: true, createdAt: true },
      },
    },
  });
  if (!row) throw errors.notFound('BotConversation', id);
  return {
    id: row.id,
    phone: row.phone,
    pausedUntil: row.pausedUntil,
    messages: row.messages.reverse(),
  };
}

/** The manager handing a conversation to, or taking it from, the bot. */
export async function setPaused(id: string, minutes: number | null): Promise<void> {
  const row = await prisma.botConversation.findUnique({ where: { id }, select: { id: true } });
  if (!row) throw errors.notFound('BotConversation', id);
  await prisma.botConversation.update({
    where: { id },
    data: { pausedUntil: minutes ? new Date(Date.now() + minutes * 60_000) : null },
  });
}
