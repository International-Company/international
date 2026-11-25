import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { containsInsensitive } from '@/core/db/search';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { transferChannels } from '@/modules/exchange/machine.service';
import { readProofImage } from '@/modules/exchange/proof-image';
import { keepMedia } from '@/modules/whatsapp/chat-images';
import { answerInGroup } from '@/modules/whatsapp/whatsapp.service';
import { sentWords } from '@/modules/whatsapp/sent-words';
import { addReceipt, receiptFiles } from './bank-receipts.service';
import type { Actor } from '@/modules/exchange/transaction.service';
import { readTransferRequest, type ReadRequest } from './transfer-request';

const log = createLogger('bank:requests');

/**
 * Transfers asked for in the followed groups by people outside the system.
 *
 * The bot reads each message from another number for the four lines of a
 * transfer and, when it finds them, puts the request in the desk's list beside
 * the deals' own; one it cannot read is added by hand from the group's panel.
 * Sent, the bot answers the message it came from — "✅ تم التحويل", with the
 * bank's receipt — so whoever asked knows without asking again.
 */

function requireDesk(actor: Actor) {
  if (
    !actor.permissions.includes('bank.execute') &&
    !actor.permissions.includes('exchange.transfer.confirm')
  ) {
    throw errors.forbidden('bank.execute');
  }
}

export interface GroupMessageRef {
  chat: string;
  waId: string;
  senderJid: string | null;
  senderName: string | null;
  senderPhone: string | null;
  text: string;
}

/** What the bot would read off a message, for the hand to correct. */
export async function suggest(text: string): Promise<ReadRequest | null> {
  return readTransferRequest(text, await transferChannels());
}

/** A message from a followed group, read for a transfer: kept as a request when it is one. */
export async function fromGroup(message: GroupMessageRef, db: DbClient = prisma): Promise<boolean> {
  const read = readTransferRequest(message.text, await transferChannels(db));
  if (!read) return false;
  await db.bankRequest
    .create({
      data: {
        chat: message.chat,
        waId: message.waId,
        senderJid: message.senderJid,
        senderName: message.senderName?.slice(0, 120) ?? null,
        senderPhone: message.senderPhone,
        text: message.text.slice(0, 2000),
        account: read.account,
        name: read.name,
        channel: read.channel,
        amount: read.amount,
        currency: read.currency,
        auto: true,
      },
    })
    .catch((error: { code?: string }) => {
      if (error?.code !== 'P2002') throw error;
    });
  log.info('A transfer request was read off a group message');
  return true;
}

/** A group message the bot could not read, added to the desk's list by a person. */
export async function addByHand(
  messageId: string,
  input: { account: string; name: string | null; channel: string | null; amount: bigint; currency: string },
  actor: Actor & { name: string },
) {
  requireDesk(actor);
  const message = await prisma.groupMessage.findUnique({ where: { id: messageId } });
  if (!message) throw errors.notFound('GroupMessage', messageId);
  if (!input.account.trim()) throw errors.validation([{ path: 'account', message: 'Say where it goes' }]);
  if (input.amount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }
  const existing = await prisma.bankRequest.findUnique({
    where: { chat_waId: { chat: message.chat, waId: message.waId } },
  });
  const data = {
    account: input.account.trim(),
    name: input.name?.trim() || null,
    channel: input.channel?.trim() || null,
    amount: input.amount,
    currency: input.currency,
  };
  const row = existing
    ? await prisma.bankRequest.update({
        where: { id: existing.id },
        data: {
          ...data,
          status: existing.status === 'DISMISSED' ? 'PENDING' : existing.status,
          ...(existing.status === 'DISMISSED' ? { dismissedAt: null, dismissedByName: null } : {}),
        },
      })
    : await prisma.bankRequest.create({
        data: {
          ...data,
          chat: message.chat,
          waId: message.waId,
          senderJid: message.senderJid,
          senderName: message.senderName,
          senderPhone: message.senderPhone,
          text: message.text,
          auto: false,
          addedByName: actor.name,
        },
      });
  return { id: row.id };
}

type RequestRow = Awaited<ReturnType<typeof prisma.bankRequest.findFirstOrThrow>>;

/** A request as the desk's list reads a transfer, with the group it came from. */
export function requestLine(row: RequestRow, groupName: string | null) {
  return {
    id: row.id,
    source: 'group' as const,
    reference: groupName ?? '',
    status:
      row.status === 'SENT' ? 'POSTED' : row.status === 'DISMISSED' ? 'REVERSED' : 'PENDING_TRANSFER',
    kind: 'طلب من القروب',
    at: row.createdAt,
    channel: row.channel,
    account: row.account,
    name: row.name,
    phone: null,
    amount: row.amount,
    currency: row.currency,
    notes: null,
    by: row.senderName ?? (row.senderPhone ? `+${row.senderPhone}` : null),
    sentAt: row.sentAt,
    sentBy: row.sentByName,
    // Asked in the group by a number outside the office: whoever wrote it, and their number.
    origin: {
      kind: 'external' as 'system' | 'external',
      name: row.senderName,
      phone: row.senderPhone,
    },
    messageRef: { chat: row.chat, waId: row.waId } as { chat: string; waId: string } | null,
  };
}

/** The requests for the desk's list: those waiting, those sent today, and those of the days asked for. */
export async function forDesk(
  groupName: (chat: string) => string | null,
  range: { from: Date; to: Date } | null,
  db: DbClient = prisma,
  /** Only the requests asked in this group: the bank transfers group. */
  onlyChat?: string | null,
) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const where = onlyChat ? { chat: onlyChat } : {};
  const [waiting, sent, inRange] = await Promise.all([
    db.bankRequest.findMany({ where: { ...where, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 300 }),
    db.bankRequest.findMany({ where: { ...where, status: 'SENT', sentAt: { gte: since } }, take: 100 }),
    range
      ? db.bankRequest.findMany({
          where: { ...where, createdAt: { gte: range.from, lte: range.to }, status: { not: 'DISMISSED' } },
          orderBy: { createdAt: 'asc' },
          take: 1000,
        })
      : Promise.resolve(null),
  ]);
  const line = (row: RequestRow) => requestLine(row, groupName(row.chat));
  return { waiting: waiting.map(line), sent: sent.map(line), range: inRange?.map(line) ?? null };
}

/** The requests that match what is looked for, of any day, newest first. */
export async function searchRequests(
  term: string,
  groupName: (chat: string) => string | null,
  db: DbClient = prisma,
  onlyChat?: string | null,
) {
  const words = containsInsensitive(term);
  const plain = term.replace(/[,\s]/g, '');
  const sum = /^\d+(\.\d{1,2})?$/.test(plain)
    ? BigInt(plain.split('.')[0]!) * 100_000_000n + BigInt(((plain.split('.')[1] ?? '') + '00').slice(0, 2)) * 1_000_000n
    : null;
  const rows = await db.bankRequest.findMany({
    where: {
      ...(onlyChat ? { chat: onlyChat } : {}),
      status: { not: 'DISMISSED' },
      OR: [
        { account: words },
        { name: words },
        { channel: words },
        { senderName: words },
        { senderPhone: words },
        { text: words },
        ...(sum !== null ? [{ amount: sum }] : []),
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return rows.map((row) => requestLine(row, groupName(row.chat)));
}

/** One request in full: the message it was read from, and what was taken from it. */
export async function requestDetail(id: string, actor: Actor, groupName: (chat: string) => string | null) {
  requireDesk(actor);
  const row = await prisma.bankRequest.findUnique({ where: { id } });
  if (!row) throw errors.notFound('BankRequest', id);
  return {
    ...requestLine(row, groupName(row.chat)),
    message: row.text,
    senderPhone: row.senderPhone,
    auto: row.auto,
    addedByName: row.addedByName,
    receiptId: row.receiptId,
  };
}

/**
 * Sent from the bank: the request stops waiting, and the bot answers the message
 * it came from in the group — "✅ تم التحويل", with the bank's receipt under it
 * when there is one — and marks the message ✅.
 */
export async function markRequestSent(id: string, receipt: string | null, actor: Actor & { name: string }) {
  requireDesk(actor);
  const image = receipt ? readProofImage(receipt) : null;
  if (typeof image === 'string') throw errors.precondition('That photo cannot be kept', image);
  const row = await prisma.bankRequest.findUnique({ where: { id } });
  if (!row) throw errors.notFound('BankRequest', id);
  if (row.status !== 'PENDING') {
    throw errors.conflict('This request is not waiting on a transfer', 'errors.notPendingTransfer');
  }
  // The receipt given now joins those the groups it was passed on to answered it with.
  if (image) await addReceipt('request', id, image, { actorId: actor.id });
  await prisma.bankRequest.update({
    where: { id },
    data: { status: 'SENT', sentAt: new Date(), sentByName: actor.name },
  });

  // Answered with every receipt it has, the first with the words under it.
  const files = await receiptFiles('request', id);
  const words = sentWords(row.account);
  const quote = { id: row.waId, author: row.senderJid, text: row.text };
  try {
    if (files.length === 0) await answerInGroup(row.chat, quote, { text: words }, '✅');
    for (const [index, file] of files.entries()) {
      await answerInGroup(
        row.chat,
        quote,
        { image: file.bytes, mimetype: file.mimeType, caption: index === 0 ? words : '' },
        index === 0 ? '✅' : undefined,
      );
    }
  } catch (error) {
    log.warn('Could not answer a transfer request in its group', { error });
  }
  log.info('A transfer request from a group was sent');
  return { id };
}

/**
 * What the bot read, corrected by hand: the account, the name, the bank or the
 * sum it got wrong. Only while it waits: one sent is what was sent.
 */
export async function editRequest(
  id: string,
  input: { account: string; name: string | null; channel: string | null; amount: bigint; currency: string },
  actor: Actor,
) {
  requireDesk(actor);
  const row = await prisma.bankRequest.findUnique({ where: { id } });
  if (!row) throw errors.notFound('BankRequest', id);
  if (row.status !== 'PENDING') {
    throw errors.conflict('This request is not waiting on a transfer', 'errors.notPendingTransfer');
  }
  if (!input.account.trim()) throw errors.validation([{ path: 'account', message: 'Say where it goes' }]);
  if (input.amount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }
  await prisma.bankRequest.update({
    where: { id },
    data: {
      account: input.account.trim(),
      name: input.name?.trim() || null,
      channel: input.channel?.trim() || null,
      amount: input.amount,
      currency: input.currency,
    },
  });
  return { id };
}

/** Not the desk's: taken off the list, the group told nothing. */
export async function dismiss(id: string, actor: Actor) {
  requireDesk(actor);
  const row = await prisma.bankRequest.findUnique({ where: { id } });
  if (!row) throw errors.notFound('BankRequest', id);
  if (row.status === 'SENT') {
    throw errors.conflict('This request was already sent', 'errors.notPendingTransfer');
  }
  await prisma.bankRequest.update({
    where: { id },
    data: {
      status: 'DISMISSED',
      dismissedAt: new Date(),
      // The name as the desk reads it, in Arabic when there is one.
      dismissedByName:
        (await prisma.user.findUnique({ where: { id: actor.id }, select: { fullNameAr: true } }))?.fullNameAr ||
        actor.name,
    },
  });
  return { id };
}

/** A request's receipt, to the desk. */
export async function requestReceipt(id: string, actor: Actor) {
  requireDesk(actor);
  const row = await prisma.bankRequest.findUnique({ where: { id }, select: { receiptId: true } });
  if (!row?.receiptId) throw errors.notFound('Receipt', id);
  const file = await prisma.chatImage.findUnique({ where: { id: row.receiptId } });
  if (!file) throw errors.notFound('Receipt', id);
  return file;
}
