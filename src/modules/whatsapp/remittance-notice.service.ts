import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { customerNames, shownName } from './chat-names';
import { answer, followGroup } from './teller-whatsapp.service';

const log = createLogger('whatsapp:notices');

/**
 * Remittance notices, received and checked from the customer inbox.
 *
 * A customer sends the teller, on the teller's own number, the photo of a
 * remittance sent to them — Western Union, MoneyGram, PayPal. Before a shekel
 * is paid out it is checked with the network's agent: the photo goes, from the
 * same number, to the group the teller shares with the agent, and what the
 * agent answers under it is read back beside the customer's conversation.
 * The teller then says confirmed or rejected; a confirmed notice is what a
 * remittance is paid out against, at the next step.
 *
 * Every notice is the teller's own, as the conversation it came from is.
 */

export const NETWORKS = ['WESTERN', 'MONEYGRAM', 'PAYPAL', 'OTHER'] as const;
export type Network = (typeof NETWORKS)[number];

const NETWORK_WORDS: Record<Network, string> = {
  WESTERN: 'ويسترن يونيون',
  MONEYGRAM: 'موني غرام',
  PAYPAL: 'باي بال',
  OTHER: 'حوالة',
};

async function owned(ownerId: string, id: string) {
  const row = await prisma.remittanceNotice.findFirst({ where: { id, ownerId } });
  if (!row) throw errors.notFound('RemittanceNotice', id);
  return row;
}

/** A photo of the customer's conversation, taken as a remittance notice. */
export async function createNotice(ownerId: string, messageId: string) {
  const message = await prisma.tellerChatMessage.findFirst({
    where: { id: messageId, chat: { ownerId } },
    include: { chat: true },
  });
  if (!message) throw errors.notFound('TellerChatMessage', messageId);
  if (!message.imageId) {
    throw errors.precondition('Only a photo can be a remittance notice', 'errors.noticeNeedsPhoto');
  }
  // The same photo taken twice is the same notice.
  const already = await prisma.remittanceNotice.findFirst({ where: { ownerId, messageId } });
  if (already) return { id: already.id };
  const records = await customerNames([message.chat.phone]);
  const row = await prisma.remittanceNotice.create({
    data: {
      ownerId,
      chatId: message.chatId,
      messageId: message.id,
      imageId: message.imageId,
      customerName: shownName(message.chat.phone, message.chat.name, records),
      customerPhone: message.chat.phone,
    },
  });
  return { id: row.id };
}

/** What the teller read off it: the network, the sum, a note. */
export async function updateNotice(
  ownerId: string,
  id: string,
  input: { network?: Network; amount?: bigint | null; currency?: string | null; note?: string | null },
) {
  await owned(ownerId, id);
  await prisma.remittanceNotice.update({
    where: { id },
    data: {
      ...(input.network ? { network: input.network } : {}),
      ...(input.amount !== undefined ? { amount: input.amount && input.amount > 0n ? input.amount : null } : {}),
      ...(input.currency !== undefined ? { currency: input.currency?.trim().toUpperCase() || null } : {}),
      ...(input.note !== undefined ? { note: input.note?.trim().slice(0, 500) || null } : {}),
    },
  });
  return noticeDetail(ownerId, id);
}

/**
 * Sent for checking: the photo, from the teller's number, to the agent's group,
 * with a line saying what it is. The group is followed, so what the agent
 * answers is read; sent again, it goes again — to the same group or another.
 */
export async function sendForCheck(ownerId: string, id: string, agentChat: string) {
  const notice = await owned(ownerId, id);
  if (notice.status === 'CONFIRMED' || notice.status === 'REJECTED') {
    throw errors.conflict('This notice is already decided', 'errors.noticeDecided');
  }
  const followed = await followGroup(ownerId, agentChat, true);
  if (!followed.id) throw errors.precondition('That group cannot be used', 'errors.tellerSendFailed');
  const image = await prisma.chatImage.findUnique({ where: { id: notice.imageId } });
  if (!image) throw errors.notFound('ChatImage', notice.imageId);

  const amount = notice.amount ? ` · ${Number(notice.amount) / 1e8} ${notice.currency ?? ''}`.trimEnd() : '';
  const caption = [
    `🔍 للتشييك — ${NETWORK_WORDS[notice.network as Network] ?? 'حوالة'}${amount}`,
    notice.customerName || notice.customerPhone ? `العميل: ${notice.customerName ?? ''} ${notice.customerPhone ? `+${notice.customerPhone}` : ''}`.trim() : null,
  ]
    .filter(Boolean)
    .join('\n');

  await answer(ownerId, followed.id, caption, Buffer.from(image.data).toString('base64'));
  // The message it went as: the newest the teller's number wrote there, carrying a photo.
  const sent = await prisma.tellerChatMessage.findFirst({
    where: { chatId: followed.id, fromMe: true, imageId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const group = await prisma.tellerChat.findUnique({ where: { id: followed.id }, select: { name: true } });
  await prisma.remittanceNotice.update({
    where: { id },
    data: {
      agentChat,
      agentName: group?.name ?? null,
      sentMessageId: sent?.id ?? null,
      sentAt: new Date(),
      status: 'CHECKING',
    },
  });
  log.info('A remittance notice was sent for checking');
  return noticeDetail(ownerId, id);
}

/** The teller's word on it: confirmed by the agent, or not. */
export async function decideNotice(ownerId: string, id: string, decision: 'CONFIRMED' | 'REJECTED', by: string) {
  const notice = await owned(ownerId, id);
  if (notice.transactionId) throw errors.conflict('This notice is already paid out', 'errors.noticeDecided');
  await prisma.remittanceNotice.update({
    where: { id },
    data: { status: decision, decidedAt: new Date(), decidedByName: by },
  });
  return noticeDetail(ownerId, id);
}

/** Back to checking: a decision taken by mistake. */
export async function reopenNotice(ownerId: string, id: string) {
  const notice = await owned(ownerId, id);
  if (notice.transactionId) throw errors.conflict('This notice is already paid out', 'errors.noticeDecided');
  await prisma.remittanceNotice.update({
    where: { id },
    data: { status: notice.sentAt ? 'CHECKING' : 'NEW', decidedAt: null, decidedByName: null },
  });
  return noticeDetail(ownerId, id);
}

/**
 * What the agent said: the answers quoting the photo sent them, and failing
 * those, what was written in the group since — an agent does not always quote.
 */
async function agentReplies(notice: { agentChat: string | null; sentMessageId: string | null; sentAt: Date | null; ownerId: string }) {
  if (!notice.agentChat || !notice.sentAt) return { quoted: [], since: [] };
  const group = await prisma.tellerChat.findFirst({
    where: { ownerId: notice.ownerId, chat: notice.agentChat },
    select: { id: true },
  });
  if (!group) return { quoted: [], since: [] };
  const shape = (row: { id: string; text: string; authorName: string | null; imageId: string | null; createdAt: Date; fromMe: boolean }) => ({
    id: row.id,
    text: row.text,
    author: row.fromMe ? null : row.authorName,
    fromMe: row.fromMe,
    imageId: row.imageId,
    at: row.createdAt,
  });
  const quoted = notice.sentMessageId
    ? await prisma.tellerChatMessage.findMany({
        where: { chatId: group.id, quotedId: notice.sentMessageId },
        orderBy: { createdAt: 'asc' },
        take: 20,
      })
    : [];
  const since = await prisma.tellerChatMessage.findMany({
    where: { chatId: group.id, createdAt: { gt: notice.sentAt }, fromMe: false, id: { notIn: quoted.map((row) => row.id) } },
    orderBy: { createdAt: 'asc' },
    take: 6,
  });
  return { quoted: quoted.map(shape), since: since.map(shape) };
}

function noticeLine(row: Awaited<ReturnType<typeof owned>>) {
  return {
    id: row.id,
    chatId: row.chatId,
    messageId: row.messageId,
    imageId: row.imageId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    network: row.network,
    amount: row.amount,
    currency: row.currency,
    agentChat: row.agentChat,
    agentName: row.agentName,
    sentAt: row.sentAt,
    status: row.status,
    decidedAt: row.decidedAt,
    decidedByName: row.decidedByName,
    note: row.note,
    transactionId: row.transactionId,
    createdAt: row.createdAt,
  };
}

/** One notice in full, with what the agent has said so far. */
export async function noticeDetail(ownerId: string, id: string) {
  const row = await owned(ownerId, id);
  return { ...noticeLine(row), replies: await agentReplies(row) };
}

/** The teller's notices, newest first: those still being checked, then the rest of the last days. */
export async function listNotices(ownerId: string) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.remittanceNotice.findMany({
    where: { ownerId, OR: [{ status: { in: ['NEW', 'CHECKING'] } }, { createdAt: { gte: since } }] },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  // How many answers each has had from its agent: a quick sign it has moved.
  const counts = await Promise.all(
    rows.map(async (row) => {
      // Only those still being checked: a decided notice's answers are history.
      if (row.status !== 'CHECKING') return 0;
      const replies = await agentReplies(row);
      return replies.quoted.length + replies.since.length;
    }),
  );
  return rows.map((row, index) => ({ ...noticeLine(row), replyCount: counts[index] ?? 0 }));
}
