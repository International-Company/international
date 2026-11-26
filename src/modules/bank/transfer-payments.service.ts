import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { parseMoney, toDecimalString } from '@/core/money/money';
import * as settings from '@/modules/settings/settings.service';
import type { Actor } from '@/modules/exchange/transaction.service';
import { answerInGroup, isLinked, replyToSent } from '@/modules/whatsapp/whatsapp.service';
import { listReceipts, type ReceiptKind } from './bank-receipts.service';
import { readReceiptPhoto } from './receipt-reader';
import { dealAccount, DEAL_ACCOUNT_SELECT } from './deal-account';

const log = createLogger('bank:payments');

/**
 * A transfer paid in parts: each receipt it carries is read for the sum it
 * shows, so the desk sees what was sent and what is left — and the group the
 * transfer was asked in is told, part by part. The transfer still closes only
 * when a person presses "sent".
 */

const DESK = ['bank.execute', 'exchange.transfer.confirm'];
const requireDesk = (actor: Actor) => {
  if (!DESK.some((name) => actor.permissions.includes(name))) throw errors.forbidden('bank.execute');
};

/** What a transfer is: its sum, its money, the account, whether it still waits — and how its group is answered. */
interface Target {
  total: bigint;
  currency: string;
  account: string | null;
  pending: boolean;
  reply: ((text: string) => Promise<unknown>) | null;
}

async function targetOf(kind: ReceiptKind, id: string): Promise<Target | null> {
  if (kind === 'deal') {
    const row = await prisma.transaction.findUnique({
      where: { id },
      select: {
        payoutBankAmount: true,
        toCurrency: true,
        ...DEAL_ACCOUNT_SELECT,
        status: true,
        copyChat: true,
        copyMessageId: true,
        announcedChat: true,
        announcedMessageId: true,
      },
    });
    if (!row) return null;
    const chat = row.copyChat ?? row.announcedChat;
    const messageId = row.copyChat ? row.copyMessageId : row.announcedMessageId;
    return {
      total: row.payoutBankAmount,
      currency: row.toCurrency,
      account: dealAccount(row),
      pending: row.status === 'PENDING_TRANSFER',
      reply: chat && messageId ? (text) => replyToSent(chat, messageId, text) : null,
    };
  }
  if (kind === 'request') {
    const row = await prisma.bankRequest.findUnique({ where: { id } });
    if (!row) return null;
    return {
      total: row.amount,
      currency: row.currency,
      account: row.account,
      pending: row.status === 'PENDING',
      reply: (text) => answerInGroup(row.chat, { id: row.waId, author: row.senderJid, text: row.text }, { text }),
    };
  }
  const row = await prisma.tiktokWithdrawal.findUnique({
    where: { id },
    select: { payoutAmount: true, cashAmount: true, account: true, deletedAt: true, sentAt: true, bankChat: true, bankMessageId: true },
  });
  if (!row) return null;
  const chat = row.bankChat;
  const messageId = row.bankMessageId;
  return {
    total: row.payoutAmount - row.cashAmount,
    currency: 'ILS',
    account: row.account,
    pending: !row.deletedAt && !row.sentAt,
    reply: chat && messageId ? (text) => replyToSent(chat, messageId, text) : null,
  };
}

/** The photo a receipt is, wherever it is kept. */
async function photoOf(kind: ReceiptKind, receiptId: string) {
  if (kind === 'deal') {
    const proof = await prisma.transactionProof.findUnique({ where: { id: receiptId }, select: { data: true, mimeType: true } });
    return proof ? { bytes: Buffer.from(proof.data), mimeType: proof.mimeType } : null;
  }
  const imageId = receiptId.startsWith('own:')
    ? receiptId.slice(4)
    : (await prisma.transferReceipt.findUnique({ where: { id: receiptId }, select: { imageId: true } }))?.imageId;
  if (!imageId) return null;
  const image = await prisma.chatImage.findUnique({ where: { id: imageId }, select: { data: true, mimeType: true } });
  return image ? { bytes: Buffer.from(image.data), mimeType: image.mimeType } : null;
}

/** A reading left half done by a restart is tried again after this long. */
const STUCK_MS = 2 * 60_000;
/** One look at a transfer's receipts at a time, so a receipt is never counted twice. */
const syncing = new Map<string, Promise<void>>();

/**
 * Each of the transfer's receipts given its payment, read in the background;
 * the payment of a receipt taken off goes with it.
 */
export function syncPayments(kind: ReceiptKind, id: string): Promise<void> {
  const key = `${kind}:${id}`;
  const running = syncing.get(key);
  if (running) return running;
  const work = (async () => {
    const [receipts, rows] = await Promise.all([
      listReceipts(kind, id),
      prisma.transferPayment.findMany({ where: { kind, refId: id } }),
    ]);
    const ids = new Set(receipts.map((receipt) => receipt.id));
    // A part settled by hand has no receipt: it stays.
    const gone = rows.filter((row) => !row.receiptId.startsWith('manual:') && !ids.has(row.receiptId));
    if (gone.length) await prisma.transferPayment.deleteMany({ where: { id: { in: gone.map((row) => row.id) } } });
    const toRead: string[] = [];
    for (const receipt of receipts) {
      const row = rows.find((entry) => entry.receiptId === receipt.id);
      if (!row) {
        const made = await prisma.transferPayment.create({ data: { kind, refId: id, receiptId: receipt.id } });
        toRead.push(made.id);
      } else if (row.status === 'READING' && Date.now() - row.updatedAt.getTime() > STUCK_MS) {
        toRead.push(row.id);
      }
    }
    for (const paymentId of toRead) void readPayment(paymentId);
  })().finally(() => syncing.delete(key));
  syncing.set(key, work);
  return work;
}

/** One receipt read for its sum, then the group told what is left. */
async function readPayment(paymentId: string) {
  try {
    const row = await prisma.transferPayment.update({ where: { id: paymentId }, data: { status: 'READING' } });
    const photo = await photoOf(row.kind as ReceiptKind, row.receiptId);
    const reading = photo ? await readReceiptPhoto(photo) : null;
    const amount = reading?.amount ? parseMoney(reading.amount) : null;
    await prisma.transferPayment.updateMany({
      // Written by a person meanwhile: theirs stands.
      where: { id: paymentId, status: 'READING' },
      data: {
        status: amount ? 'READ' : 'UNREAD',
        amount,
        currency: reading?.currency ?? null,
        account: reading?.account ?? null,
        name: reading?.name ?? null,
      },
    });
    if (amount) await announce(row.kind as ReceiptKind, row.refId);
  } catch (error) {
    log.warn('Could not read a transfer receipt', { error });
    await prisma.transferPayment.updateMany({ where: { id: paymentId, status: 'READING' }, data: { status: 'UNREAD' } }).catch(() => undefined);
  }
}

const figure = (value: bigint) => toDecimalString(value, 2).replace(/\.00$/, '');

/** One whole shekel or dollar, scaled: less than this left over is the fraction a receipt rounds away. */
const WHOLE = 100_000_000n;

/** What is left of a sum once this much was sent: nothing, when it is less than one whole unit. */
export function leftOf(total: bigint, paid: bigint): bigint {
  const left = total - paid;
  return left >= WHOLE ? left : 0n;
}

/** What the payments add up to, counted in the transfer's money: one in other money is not added. */
function paidOf(rows: { amount: bigint | null; currency: string | null }[], currency: string) {
  return rows.reduce((sum, row) => (row.amount && (!row.currency || row.currency === currency) ? sum + row.amount : sum), 0n);
}

/**
 * The group the transfer was asked in, told of the parts not told of yet: what
 * was sent now, all so far, and what is left. Not once it is all sent — the
 * "sent" pressed at the desk answers that — nor once it has closed.
 */
async function announce(kind: ReceiptKind, id: string) {
  const target = await targetOf(kind, id);
  if (!target?.pending || !target.reply) return;
  const rows = await prisma.transferPayment.findMany({ where: { kind, refId: id } });
  const fresh = rows.filter((row) => row.amount && !row.announcedAt);
  if (fresh.length === 0) return;
  const paid = paidOf(rows, target.currency);
  const now = new Date();
  // Claimed before it is written, so two readings ending together say it once.
  const claimed = await prisma.transferPayment.updateMany({
    where: { id: { in: fresh.map((row) => row.id) }, announcedAt: null },
    data: { announcedAt: now },
  });
  if (claimed.count === 0 || paid <= 0n || leftOf(target.total, paid) === 0n) return;
  if (!(await settings.getBoolean('whatsapp.enabled')) || !isLinked()) return;
  const sentNow = paidOf(fresh, target.currency);
  const text = [
    `💸 تم تحويل ${figure(sentNow)} ${target.currency}`,
    `المحوَّل حتى الآن: ${figure(paid)} من ${figure(target.total)}`,
    `المتبقي: ${figure(leftOf(target.total, paid))} ${target.currency}`,
  ].join('\n');
  await target.reply(text).catch((error) => log.warn('Could not tell a group what is left of a transfer', { error }));
}

/** The last four digits of an account, as two writings of one number are matched. */
const tail = (value: string | null | undefined) => {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? digits.slice(-4) : null;
};

/** A transfer's parts: each receipt's sum, all sent so far, and what is left. */
export async function paymentSummary(kind: ReceiptKind, id: string, actor: Actor) {
  requireDesk(actor);
  const target = await targetOf(kind, id);
  if (!target) throw errors.notFound('Transfer', id);
  await syncPayments(kind, id);
  const rows = await prisma.transferPayment.findMany({ where: { kind, refId: id }, orderBy: { createdAt: 'asc' } });
  const paid = paidOf(rows, target.currency);
  const expected = tail(target.account);
  return {
    total: target.total,
    currency: target.currency,
    paid,
    remaining: leftOf(target.total, paid),
    over: paid - target.total >= WHOLE ? paid - target.total : 0n,
    pending: target.pending,
    payments: rows.map((row) => {
      const read = tail(row.account);
      return {
        id: row.id,
        receiptId: row.receiptId,
        status: row.status,
        amount: row.amount,
        currency: row.currency,
        account: row.account,
        name: row.name,
        editedByName: row.editedByName,
        /** The receipt's account against the transfer's: null when either cannot be told. */
        accountMatches: read && expected ? read === expected : null,
        /** In other money than the transfer: shown, not counted. */
        otherMoney: Boolean(row.currency && row.currency !== target.currency),
      };
    }),
  };
}

/** A sum written by hand where the bot read it wrong, or could not. */
export async function editPayment(paymentId: string, amount: bigint | null, actor: Actor & { name: string }) {
  requireDesk(actor);
  const row = await prisma.transferPayment.findUnique({ where: { id: paymentId } });
  if (!row) throw errors.notFound('TransferPayment', paymentId);
  const name =
    (await prisma.user.findUnique({ where: { id: actor.id }, select: { fullNameAr: true } }))?.fullNameAr || actor.name;
  await prisma.transferPayment.update({
    where: { id: paymentId },
    data: {
      status: 'EDITED',
      amount: amount && amount > 0n ? amount : null,
      // Written in the transfer's own money.
      currency: null,
      editedByName: name,
    },
  });
  if (amount && amount > 0n) await announce(row.kind as ReceiptKind, row.refId);
  return paymentSummary(row.kind as ReceiptKind, row.refId, actor);
}

/** What was sent so far of each waiting transfer, for the desk's list. */
export async function paidSoFar(lines: { kind: ReceiptKind; id: string; currency: string }[]) {
  const paid = new Map<string, bigint>();
  if (lines.length === 0) return paid;
  const rows = await prisma.transferPayment.findMany({
    where: { OR: lines.map((line) => ({ kind: line.kind, refId: line.id })), amount: { not: null } },
    select: { kind: true, refId: true, amount: true, currency: true },
  });
  for (const line of lines) {
    const sum = paidOf(rows.filter((row) => row.kind === line.kind && row.refId === line.id), line.currency);
    if (sum > 0n) paid.set(`${line.kind}:${line.id}`, sum);
  }
  return paid;
}

/**
 * What was sent so far of deals still waiting on their transfer, by deal: for
 * the pages that show a deal outside the bank desk — the transactions, a
 * teller's day, the remittance board. Only those paid in part.
 */
export async function dealParts(ids: string[]) {
  const parts = new Map<string, { total: bigint; paid: bigint; remaining: bigint; currency: string; closed: boolean }>();
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return parts;
  const deals = await prisma.transaction.findMany({
    where: { id: { in: unique }, status: { in: ['PENDING_TRANSFER', 'POSTED'] }, payoutBankAmount: { gt: 0n } },
    select: { id: true, payoutBankAmount: true, toCurrency: true, status: true },
  });
  if (deals.length === 0) return parts;
  const paid = await paidSoFar(deals.map((deal) => ({ kind: 'deal' as const, id: deal.id, currency: deal.toCurrency })));
  for (const deal of deals) {
    const sum = paid.get(`deal:${deal.id}`);
    if (!sum) continue;
    const closed = deal.status !== 'PENDING_TRANSFER';
    // Closed with all of it sent: nothing to say.
    if (closed && leftOf(deal.payoutBankAmount, sum) === 0n) continue;
    parts.set(deal.id, {
      closed,
      total: deal.payoutBankAmount,
      paid: sum,
      remaining: leftOf(deal.payoutBankAmount, sum),
      currency: deal.toCurrency,
    });
  }
  return parts;
}

/** The same, put on each row as `parts` — null where nothing was sent yet. */
export async function withDealParts<T extends { id: string }>(rows: T[]) {
  const parts = await dealParts(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, parts: parts.get(row.id) ?? null }));
}

/**
 * A receipt that came from a group, read before anything is decided on it:
 * 'whole' when it covers the transfer, 'short' when it is only part of it,
 * 'unknown' when it could not be read in time. Waits for the reading itself.
 */
export async function coverOf(kind: ReceiptKind, id: string, receiptId: string, waitMs = 45_000) {
  await syncPayments(kind, id);
  const until = Date.now() + waitMs;
  let row = await prisma.transferPayment.findFirst({ where: { kind, refId: id, receiptId } });
  while (row && row.status === 'READING' && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    row = await prisma.transferPayment.findFirst({ where: { kind, refId: id, receiptId } });
  }
  const target = await targetOf(kind, id);
  if (!row?.amount || !target) return 'unknown' as const;
  if (row.currency && row.currency !== target.currency) return 'unknown' as const;
  return leftOf(target.total, row.amount) === 0n ? ('whole' as const) : ('short' as const);
}

/** Sent in part already: a sum read or written on one of its other receipts. */
export async function hasPartBefore(kind: ReceiptKind, id: string, receiptId: string) {
  return (
    (await prisma.transferPayment.count({
      where: { kind, refId: id, receiptId: { not: receiptId }, amount: { not: null } },
    })) > 0
  );
}

/**
 * What is left of a transfer, settled by hand: sent some other way, with no
 * receipt to read. Kept as a part of its own, by whom, so the sums add up and
 * the remainder leaves the list.
 */
export async function settleRemainder(kind: ReceiptKind, id: string, actor: Actor & { name: string }) {
  requireDesk(actor);
  const target = await targetOf(kind, id);
  if (!target) throw errors.notFound('Transfer', id);
  const rows = await prisma.transferPayment.findMany({ where: { kind, refId: id } });
  const left = leftOf(target.total, paidOf(rows, target.currency));
  if (left <= 0n) throw errors.conflict('Nothing is left of this transfer', 'errors.nothingLeft');
  const name =
    (await prisma.user.findUnique({ where: { id: actor.id }, select: { fullNameAr: true } }))?.fullNameAr || actor.name;
  await prisma.transferPayment.create({
    data: {
      kind,
      refId: id,
      receiptId: `manual:${Date.now()}`,
      status: 'EDITED',
      amount: left,
      currency: target.currency,
      editedByName: name,
      // Settled by hand: the group is not told of it as a part.
      announcedAt: new Date(),
    },
  });
  log.info('What was left of a transfer was settled by hand', { kind });
  return paymentSummary(kind, id, actor);
}
