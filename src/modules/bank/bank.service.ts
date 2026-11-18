import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { emitAsync } from '@/core/events/bus';
import { createLogger } from '@/core/logger/logger';
import { BANK_EXECUTE } from './bank-desk';
import { forDesk } from './bank-request.service';
import { bankGroup, watched } from './group-feed.service';
import { readProofImage } from '@/modules/exchange/proof-image';
import { confirmTransfer, type Actor } from '@/modules/exchange/transaction.service';
import { TRANSACTION_TYPE_META, type TransactionType } from '@/modules/exchange/transaction-types';

const log = createLogger('bank');

/**
 * The bank desk: the office's transfers, sent from its accounts by one person.
 *
 * Every deal that promised a customer money by transfer waits here until whoever
 * the manager named on the settings page has sent it from the bank's app and
 * said so. That person needs no role of their own: being named is what lets them
 * in, and the manager sees the same list.
 */

/** Who may work the desk: the one named, or a manager. */
export function canWorkDesk(actor: { permissions: string[] }): boolean {
  return (
    actor.permissions.includes(BANK_EXECUTE) ||
    actor.permissions.includes('exchange.transfer.confirm')
  );
}

function requireDesk(actor: Actor) {
  if (!canWorkDesk(actor)) throw errors.forbidden(BANK_EXECUTE);
}

const SELECT = {
  id: true,
  reference: true,
  status: true,
  type: true,
  createdAt: true,
  toCurrency: true,
  payoutBankAmount: true,
  payoutBankChannel: true,
  payoutAccount: true,
  counterpartyName: true,
  counterpartyPhone: true,
  recipientName: true,
  recipientPhone: true,
  notes: true,
  transferConfirmedAt: true,
  announcedChat: true,
  announcedMessageId: true,
  copyChat: true,
  copyMessageId: true,
  customer: { select: { fullNameAr: true, phone: true } },
  createdBy: { select: { fullNameAr: true } },
  transferConfirmedBy: { select: { fullNameAr: true } },
} as const;

type Row = {
  id: string;
  reference: string;
  status: string;
  type: string;
  createdAt: Date;
  toCurrency: string;
  payoutBankAmount: bigint;
  payoutBankChannel: string | null;
  payoutAccount: string | null;
  counterpartyName: string | null;
  counterpartyPhone: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  notes: string | null;
  transferConfirmedAt: Date | null;
  announcedChat?: string | null;
  announcedMessageId?: string | null;
  copyChat?: string | null;
  copyMessageId?: string | null;
  customer: { fullNameAr: string; phone: string | null } | null;
  createdBy: { fullNameAr: string } | null;
  transferConfirmedBy: { fullNameAr: string } | null;
};

/** One transfer as the desk reads it: where to, to whom, how much, and from which deal. */
export function deskLine(row: Row) {
  const received = row.type === 'REMITTANCE_IN' || row.type === 'PAYPAL_IN';
  const phone =
    (received ? row.recipientPhone : null) ??
    row.customer?.phone ??
    row.counterpartyPhone ??
    row.recipientPhone ??
    null;
  return {
    id: row.id,
    source: 'deal' as const,
    reference: row.reference,
    status: row.status,
    kind: TRANSACTION_TYPE_META[row.type as TransactionType]?.nameAr ?? row.type,
    at: row.createdAt,
    channel: row.payoutBankChannel,
    // The account it goes to; a wallet is often just the number, so the phone stands in.
    account: row.payoutAccount?.trim() || phone,
    name: (received ? row.recipientName : null) ?? row.customer?.fullNameAr ?? row.counterpartyName ?? row.recipientName,
    phone,
    amount: row.payoutBankAmount,
    currency: row.toCurrency,
    notes: row.notes,
    by: row.createdBy?.fullNameAr ?? null,
    sentAt: row.transferConfirmedAt,
    sentBy: row.transferConfirmedBy?.fullNameAr ?? null,
    // Its message in the groups: the transfers group's copy first, else its own announcement.
    messageRef: (row.copyChat && row.copyMessageId
      ? { chat: row.copyChat, waId: row.copyMessageId }
      : row.announcedChat && row.announcedMessageId
        ? { chat: row.announcedChat, waId: row.announcedMessageId }
        : null) as { chat: string; waId: string } | null,
  };
}

/**
 * One transfer in full, for the desk: the deal behind it — what came in and went
 * out, at what price and how, for whom and by whom — and the photos it carries.
 * The desk needs no right to the transactions list to read the one it is sending.
 */
export async function deskDetail(id: string, actor: Actor, db: DbClient = prisma) {
  requireDesk(actor);
  const row = await db.transaction.findUnique({
    where: { id },
    select: {
      ...SELECT,
      status: true,
      fromCurrency: true,
      fromAmount: true,
      toAmount: true,
      rate: true,
      intakeCashAmount: true,
      intakeBrokerAmount: true,
      intakeBankChannel: true,
      payoutCashAmount: true,
      recipientIdNumber: true,
      deliveredAmount: true,
      deliveredUnit: true,
      customer: { select: { fullNameAr: true, phone: true, code: true } },
      branch: { select: { nameAr: true } },
      proofs: { select: { id: true, kind: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!row) throw errors.notFound('Transaction', id);
  return {
    ...deskLine(row),
    status: row.status,
    fromCurrency: row.fromCurrency,
    fromAmount: row.fromAmount,
    toAmount: row.toAmount,
    rate: row.rate,
    intakeCash: row.intakeCashAmount,
    intakeTransfer: row.intakeBrokerAmount,
    intakeChannel: row.intakeBankChannel,
    payoutCash: row.payoutCashAmount,
    customerCode: row.customer?.code ?? null,
    counterpartyName: row.counterpartyName,
    recipientName: row.recipientName,
    recipientPhone: row.recipientPhone,
    recipientIdNumber: row.recipientIdNumber,
    delivered:
      row.deliveredAmount !== null
        ? { amount: row.deliveredAmount, unit: row.deliveredUnit ?? '' }
        : null,
    branch: row.branch?.nameAr ?? null,
    proofs: row.proofs,
  };
}

/** A photo a transfer's deal carries, to the desk. */
export async function deskProof(id: string, proofId: string, actor: Actor, db: DbClient = prisma) {
  requireDesk(actor);
  const proof = await db.transactionProof.findFirst({
    where: { id: proofId, transactionId: id },
    select: { data: true, mimeType: true },
  });
  if (!proof) throw errors.notFound('Proof', proofId);
  return proof;
}

/** What is still to be sent, oldest first, and what was sent today. */
export async function desk(
  actor: Actor,
  db: DbClient = prisma,
  /** Days asked for: every transfer promised in them, sent or not, not only what waits. */
  range?: { from: Date; to: Date } | null,
) {
  requireDesk(actor);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  /*
   * The bank transfers group is the desk's list: the deals whose transfer went
   * there, and the requests written there. With no such group set, every
   * transfer, as before.
   */
  const bank = await bankGroup();
  const inBankGroup = bank
    ? { OR: [{ copyChat: bank.id }, { announcedChat: bank.id }] }
    : {};
  const [waiting, sent] = await Promise.all([
    db.transaction.findMany({
      where: {
        status: 'PENDING_TRANSFER',
        payoutBankAmount: { gt: 0n },
        reversalOfId: null,
        AND: [
          // A USDT send awaiting the manager's release is not the desk's yet; NULL is no approval asked.
          { OR: [{ approvalState: null }, { approvalState: { not: 'PENDING' } }] },
          inBankGroup,
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 300,
      select: SELECT,
    }),
    db.transaction.findMany({
      where: { transferConfirmedAt: { gte: since }, payoutBankAmount: { gt: 0n }, ...inBankGroup },
      orderBy: { transferConfirmedAt: 'desc' },
      take: 100,
      select: SELECT,
    }),
  ]);
  const inRange = range
    ? await db.transaction.findMany({
        where: {
          createdAt: { gte: range.from, lte: range.to },
          payoutBankAmount: { gt: 0n },
          reversalOfId: null,
          ...inBankGroup,
        },
        orderBy: { createdAt: 'asc' },
        take: 1000,
        select: SELECT,
      })
    : null;
  // The groups' requests beside the deals, each list in the order things happened.
  const groups = await watched();
  const groupName = (chat: string) => groups.find((group) => group.id === chat)?.name ?? null;
  const requests = await forDesk(groupName, range ?? null, db, bank?.id ?? null);
  const byTime = <T extends { at: Date }>(list: T[]) =>
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
  const lists = {
    waiting: byTime([...waiting.map(deskLine), ...requests.waiting]),
    sent: [...sent.map(deskLine), ...requests.sent],
    range: inRange ? byTime([...inRange.map(deskLine), ...(requests.range ?? [])]) : null,
  };

  // Each transfer's message as the groups' panel kept it: to check where it came from, and pass it on.
  const refs = [...lists.waiting, ...lists.sent, ...(lists.range ?? [])]
    .map((line) => line.messageRef)
    .filter((ref): ref is { chat: string; waId: string } => Boolean(ref));
  const kept = refs.length
    ? await db.groupMessage.findMany({
        where: { OR: refs.map((ref) => ({ chat: ref.chat, waId: ref.waId })) },
        select: { id: true, chat: true, waId: true },
      })
    : [];
  const withMessage = <T extends { messageRef: { chat: string; waId: string } | null }>(line: T) => {
    const { messageRef, ...rest } = line;
    return {
      ...rest,
      messageId:
        (messageRef &&
          kept.find((row) => row.chat === messageRef.chat && row.waId === messageRef.waId)?.id) ??
        null,
    };
  };
  return {
    group: bank,
    waiting: lists.waiting.map(withMessage),
    sent: lists.sent.map(withMessage),
    range: lists.range?.map(withMessage) ?? null,
  };
}

/**
 * A transfer sent from the bank: the deal stops waiting, with the bank's receipt
 * kept on it when one is given, and the group is told.
 */
export async function markSent(
  id: string,
  receipt: string | null,
  actor: Actor,
  db: DbClient = prisma,
) {
  requireDesk(actor);
  // Read before anything is written: a bad photo marks nothing sent.
  const image = receipt ? readProofImage(receipt) : null;
  if (typeof image === 'string') throw errors.precondition('That photo cannot be kept', image);

  const row = await db.transaction.findUnique({
    where: { id },
    select: { payoutBankAmount: true, status: true },
  });
  if (!row) throw errors.notFound('Transaction', id);
  if (row.payoutBankAmount <= 0n) {
    throw errors.conflict('This deal sends nothing by transfer', 'errors.notPendingTransfer');
  }

  // The desk confirms as the manager would; the one named holds no role for it.
  const result = await confirmTransfer(id, {
    ...actor,
    permissions: [...actor.permissions, 'exchange.transfer.confirm'],
  });

  let proofId: string | null = null;
  if (image) {
    const proof = await db.transactionProof.create({
      data: {
        transactionId: id,
        kind: 'TRANSFER',
        mimeType: image.mimeType,
        size: image.bytes.length,
        data: new Uint8Array(image.bytes),
        createdById: actor.id,
      },
      select: { id: true },
    });
    proofId = proof.id;
  }

  log.info('A transfer was sent from the bank desk', { reference: result.reference });
  emitAsync('transaction.transferSent', { transactionId: id, proofId, actorId: actor.id });
  return result;
}
