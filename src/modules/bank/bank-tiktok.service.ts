import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { containsInsensitive } from '@/core/db/search';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { readProofImage } from '@/modules/exchange/proof-image';
import { keepMedia } from '@/modules/whatsapp/chat-images';
import { reactTo, replyToSent, sendImage, sentStub } from '@/modules/whatsapp/whatsapp.service';
import { sentWords } from '@/modules/whatsapp/sent-words';
import type { Actor } from '@/modules/exchange/transaction.service';

const log = createLogger('bank:tiktok');

/**
 * TikTok withdrawals on the bank desk.
 *
 * A withdrawal is kept apart from the deals — it moves no balance — but what it
 * pays by transfer is a transfer like any other: it goes to the bank transfers
 * group, and the desk lists it, follows it and marks it sent. Only those whose
 * transfer went to that group are the desk's; a withdrawal paid in notes, or
 * recorded before the group was told of them, is not.
 */

function requireDesk(actor: Actor) {
  if (
    !actor.permissions.includes('bank.execute') &&
    !actor.permissions.includes('exchange.transfer.confirm')
  ) {
    throw errors.forbidden('bank.execute');
  }
}

const SELECT = {
  id: true,
  amount: true,
  rate: true,
  payoutAmount: true,
  cashAmount: true,
  account: true,
  beneficiaryName: true,
  channel: true,
  createdAt: true,
  deletedAt: true,
  sentAt: true,
  sentByName: true,
  receiptId: true,
  announcedChat: true,
  announcedMessageId: true,
  bankChat: true,
  bankMessageId: true,
  createdBy: { select: { fullNameAr: true } },
} as const;

type Row = Awaited<ReturnType<typeof prisma.tiktokWithdrawal.findFirstOrThrow<{ select: typeof SELECT }>>>;

/** A withdrawal as the desk's list reads a transfer: its transfer part, to whom, by whom. */
export function tiktokLine(row: Row) {
  return {
    id: row.id,
    source: 'tiktok' as const,
    reference: 'TikTok',
    status: row.deletedAt ? 'REVERSED' : row.sentAt ? 'POSTED' : 'PENDING_TRANSFER',
    kind: 'سحب تيكتوك',
    at: row.createdAt,
    channel: row.channel || null,
    account: row.account || null,
    name: row.beneficiaryName,
    phone: null,
    amount: row.payoutAmount - row.cashAmount,
    currency: 'ILS',
    notes: null,
    by: row.createdBy?.fullNameAr ?? null,
    sentAt: row.sentAt,
    sentBy: row.sentByName,
    // Recorded at the counter: the system's own, by the teller who recorded it.
    origin: {
      kind: 'system' as 'system' | 'external',
      name: row.createdBy?.fullNameAr ?? null,
      phone: null as string | null,
    },
    // Its copy in the bank group first, else the withdrawal's own message.
    messageRef: (row.bankChat && row.bankMessageId
      ? { chat: row.bankChat, waId: row.bankMessageId }
      : row.announcedChat && row.announcedMessageId
        ? { chat: row.announcedChat, waId: row.announcedMessageId }
        : null) as { chat: string; waId: string } | null,
  };
}

/** The withdrawals for the desk's list: those waiting, those sent today, and those of the days asked for. */
export async function tiktokForDesk(
  range: { from: Date; to: Date } | null,
  db: DbClient = prisma,
  /** The bank transfers group: only what was copied there is the desk's. */
  bankChat: string | null,
) {
  if (!bankChat) return { waiting: [], sent: [], range: range ? [] : null };
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const where = { bankChat };
  const [waiting, sent, inRange] = await Promise.all([
    db.tiktokWithdrawal.findMany({
      where: { ...where, deletedAt: null, sentAt: null },
      orderBy: { createdAt: 'asc' },
      take: 300,
      select: SELECT,
    }),
    db.tiktokWithdrawal.findMany({
      where: { ...where, deletedAt: null, sentAt: { gte: since } },
      take: 100,
      select: SELECT,
    }),
    range
      ? db.tiktokWithdrawal.findMany({
          where: { ...where, deletedAt: null, createdAt: { gte: range.from, lte: range.to } },
          orderBy: { createdAt: 'asc' },
          take: 1000,
          select: SELECT,
        })
      : Promise.resolve(null),
  ]);
  return {
    waiting: waiting.map(tiktokLine),
    sent: sent.map(tiktokLine),
    range: inRange?.map(tiktokLine) ?? null,
  };
}

/** The withdrawals that match what is looked for, of any day, newest first. */
export async function searchTiktok(term: string, db: DbClient = prisma, bankChat: string | null) {
  if (!bankChat) return [];
  const words = containsInsensitive(term);
  const rows = await db.tiktokWithdrawal.findMany({
    where: {
      bankChat,
      deletedAt: null,
      OR: [{ account: words }, { beneficiaryName: words }, { channel: words }],
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: SELECT,
  });
  return rows.map(tiktokLine);
}

/** One withdrawal in full, for the desk: the dollars, the price, how it was paid, its photos. */
export async function tiktokDetail(id: string, actor: Actor, db: DbClient = prisma) {
  requireDesk(actor);
  const row = await db.tiktokWithdrawal.findUnique({
    where: { id },
    select: { ...SELECT, photos: { select: { id: true }, orderBy: { createdAt: 'asc' } } },
  });
  if (!row) throw errors.notFound('TiktokWithdrawal', id);
  const line = tiktokLine(row);
  return {
    ...line,
    fromCurrency: 'USD',
    fromAmount: row.amount,
    toAmount: row.payoutAmount,
    rate: row.rate,
    intakeCash: 0n,
    intakeTransfer: 0n,
    intakeChannel: null,
    payoutCash: row.cashAmount,
    customerCode: null,
    counterpartyName: null,
    recipientName: null,
    recipientPhone: null,
    recipientIdNumber: null,
    delivered: null,
    branch: null,
    receiptId: row.receiptId,
    // The withdrawal's photo first, then the rest it carries.
    proofs: [
      { id: 'main', kind: 'TIKTOK' },
      ...row.photos.map((photo) => ({ id: photo.id, kind: 'TIKTOK' })),
      ...(row.receiptId ? [{ id: 'receipt', kind: 'TRANSFER' }] : []),
    ],
  };
}

/** A photo a withdrawal carries, or its receipt, to the desk. */
export async function tiktokPhoto(id: string, photoId: string, actor: Actor, db: DbClient = prisma) {
  requireDesk(actor);
  if (photoId === 'main') {
    const row = await db.tiktokWithdrawal.findUnique({ where: { id }, select: { data: true, mimeType: true } });
    if (!row) throw errors.notFound('TiktokWithdrawal', id);
    return row;
  }
  if (photoId === 'receipt') {
    const row = await db.tiktokWithdrawal.findUnique({ where: { id }, select: { receiptId: true } });
    const file = row?.receiptId ? await db.chatImage.findUnique({ where: { id: row.receiptId } }) : null;
    if (!file) throw errors.notFound('Receipt', id);
    return { data: file.data, mimeType: file.mimeType };
  }
  const photo = await db.tiktokPhoto.findFirst({
    where: { id: photoId, withdrawalId: id },
    select: { data: true, mimeType: true },
  });
  if (!photo) throw errors.notFound('TiktokPhoto', photoId);
  return photo;
}

/** Its transfer sent from the bank: no longer waiting, with the bank's receipt kept when given. */
export async function markTiktokSent(id: string, receipt: string | null, actor: Actor & { name: string }) {
  requireDesk(actor);
  const image = receipt ? readProofImage(receipt) : null;
  if (typeof image === 'string') throw errors.precondition('That photo cannot be kept', image);
  const row = await prisma.tiktokWithdrawal.findUnique({
    where: { id },
    select: { deletedAt: true, sentAt: true, bankChat: true, bankMessageId: true, account: true, receiptId: true },
  });
  if (!row) throw errors.notFound('TiktokWithdrawal', id);
  if (row.deletedAt || row.sentAt) {
    throw errors.conflict('This withdrawal is not waiting on a transfer', 'errors.notPendingTransfer');
  }
  const kept = image ? await keepMedia(image, null) : null;
  await prisma.tiktokWithdrawal.update({
    where: { id },
    data: { sentAt: new Date(), sentByName: actor.name, ...(kept ? { receiptId: kept.id } : {}) },
  });
  // Marked in the bank group as the deals' are, with the bank's receipt under it.
  if (row.bankChat && row.bankMessageId) {
    const chat = row.bankChat;
    const messageId = row.bankMessageId;
    await reactTo(chat, messageId, '✅').catch((error) => log.warn('Could not mark a TikTok transfer sent', { error }));
    // The receipt given now, else the one already kept; the words alone when there is none.
    const found =
      image ??
      (row.receiptId
        ? await prisma.chatImage
            .findUnique({ where: { id: row.receiptId }, select: { data: true, mimeType: true } })
            .then((file) => (file ? { bytes: Buffer.from(file.data), mimeType: file.mimeType } : null))
        : null);
    const words = sentWords(row.account);
    await (found
      ? sendImage(chat, found.bytes, words, sentStub(chat, messageId), found.mimeType)
      : replyToSent(chat, messageId, words)
    ).catch((error) => log.warn('Could not answer a TikTok transfer in its group', { error }));
  }
  log.info('A TikTok transfer was sent from the bank desk');
  return { id };
}
