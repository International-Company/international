import 'server-only';
import { containsInsensitive } from '@/core/db/search';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { emitAsync } from '@/core/events/bus';
import { createLogger } from '@/core/logger/logger';
import { BANK_EXECUTE } from './bank-desk';
import { forDesk, searchRequests } from './bank-request.service';
import { searchTiktok, tiktokForDesk } from './bank-tiktok.service';
import { bankGroup, executorGroups, watched } from './group-feed.service';
import { paidSoFar, syncPayments } from './transfer-payments.service';
import { readTransferRequest } from './transfer-request';
import { transferChannels } from '@/modules/exchange/machine.service';
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
    // Recorded at the counter: the system's own, by the teller who recorded it.
    origin: {
      kind: 'system' as 'system' | 'external',
      name: row.createdBy?.fullNameAr ?? null,
      phone: null as string | null,
    },
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

/** A sum as it may be typed, "1740" or "1,740.5", scaled as amounts are kept; null when it is not one. */
export function typedSum(term: string): bigint | null {
  const plain = term.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(plain)) return null;
  const [whole, fraction = ''] = plain.split('.');
  return BigInt(whole!) * 100_000_000n + BigInt((fraction + '00').slice(0, 2)) * 1_000_000n;
}

/** What a deal is looked for by: whose it is, where it goes, its number, its sum. */
function dealMatches(term: string) {
  const words = containsInsensitive(term);
  const sum = typedSum(term);
  return [
    { reference: words },
    { payoutAccount: words },
    { payoutBankChannel: words },
    { recipientName: words },
    { recipientPhone: words },
    { counterpartyName: words },
    { counterpartyPhone: words },
    { notes: words },
    { customer: { fullNameAr: words } },
    { customer: { phone: words } },
    ...(sum !== null ? [{ payoutBankAmount: sum }] : []),
  ];
}

/** What is still to be sent, oldest first, and what was sent today. */
export async function desk(
  actor: Actor,
  db: DbClient = prisma,
  /** Days asked for: every transfer promised in them, sent or not, not only what waits. */
  range?: { from: Date; to: Date } | null,
  /** Words or digits looked for in every day: a name, an account or phone, a reference, a sum. */
  search?: string | null,
) {
  // A number typed with spaces or dashes, "059 211-7818", is looked for as its digits.
  const typed = search?.trim() || null;
  const term = typed && /^[\d\s+-]+$/.test(typed) ? typed.replace(/\D/g, '') || null : typed;
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
  const inRange = term
    ? await db.transaction.findMany({
        where: {
          payoutBankAmount: { gt: 0n },
          reversalOfId: null,
          AND: [inBankGroup, { OR: dealMatches(term) }],
        },
        // The newest first: what is looked for is most often recent.
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: SELECT,
      })
    : range
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
  // TikTok withdrawals whose transfer went to the bank group: transfers like the rest.
  const tiktok = await tiktokForDesk(range ?? null, db, bank?.id ?? null);
  // Looked for: what matches, of any day, in place of the days' list.
  if (term) {
    requests.range = await searchRequests(term, groupName, db, bank?.id ?? null);
    tiktok.range = await searchTiktok(term, db, bank?.id ?? null);
  }
  const byTime = <T extends { at: Date }>(list: T[]) =>
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
  const lists = {
    waiting: byTime([...waiting.map(deskLine), ...requests.waiting, ...tiktok.waiting]),
    sent: [...sent.map(deskLine), ...requests.sent, ...tiktok.sent],
    range: inRange
      ? byTime([...inRange.map(deskLine), ...(requests.range ?? []), ...(tiktok.range ?? [])])
      : null,
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
  /*
   * Where each was passed on to. Passed on by a person, or to one of the groups
   * that carry transfers out, a transfer still waiting is "forwarded": someone
   * has it in hand. A rule copying it elsewhere does not count.
   */
  const executors = await executorGroups();
  const forwards = refs.length
    ? await db.groupForward.findMany({
        where: { OR: refs.map((ref) => ({ sourceChat: ref.chat, sourceWaId: ref.waId })) },
        orderBy: { createdAt: 'asc' },
        select: { sourceChat: true, sourceWaId: true, targetChat: true, targetName: true, auto: true, createdAt: true },
      })
    : [];
  const handedOn = (ref: { chat: string; waId: string } | null) =>
    ref
      ? forwards
          .filter(
            (entry) =>
              entry.sourceChat === ref.chat &&
              entry.sourceWaId === ref.waId &&
              (!entry.auto || executors.some((group) => group.id === entry.targetChat)),
          )
          .map((entry) => ({ group: entry.targetName ?? entry.targetChat, at: entry.createdAt }))
      : [];
  const kindOf = (source: string | undefined) =>
    (source === 'group' ? 'request' : source === 'tiktok' ? 'tiktok' : 'deal') as 'deal' | 'request' | 'tiktok';
  // Waiting, and sent: one closed short of its sum is shown so, with what is left of it.
  const counted = [...lists.waiting, ...lists.sent, ...(lists.range ?? [])].filter((line) => line.status !== 'REVERSED');
  const paid = await paidSoFar(
    counted.map((line) => ({ kind: kindOf((line as { source?: string }).source), id: line.id, currency: line.currency })),
  );
  /*
   * Today's sent transfers whose receipts were never read — closed before the
   * desk read receipts — read once in the background, so one closed short of
   * its sum is found. Each is read once: its payments are kept.
   */
  const unread = lists.sent.filter((line) => !paid.has(`${kindOf((line as { source?: string }).source)}:${line.id}`));
  if (unread.length) {
    const known = await db.transferPayment.findMany({
      where: { OR: unread.map((line) => ({ kind: kindOf((line as { source?: string }).source), refId: line.id })) },
      select: { kind: true, refId: true },
    });
    for (const line of unread.slice(0, 40)) {
      const kind = kindOf((line as { source?: string }).source);
      if (known.some((row) => row.kind === kind && row.refId === line.id)) continue;
      void syncPayments(kind, line.id).catch(() => undefined);
    }
  }
  const withMessage = <T extends { id: string; status: string; messageRef: { chat: string; waId: string } | null }>(line: T) => {
    const { messageRef, ...rest } = line;
    return {
      ...rest,
      /** Sent so far, as its receipts read: of one paid in parts, or one closed short of its sum. */
      paid:
        line.status !== 'REVERSED'
          ? (paid.get(`${kindOf((line as { source?: string }).source)}:${line.id}`) ?? null)
          : null,
      messageId:
        (messageRef &&
          kept.find((row) => row.chat === messageRef.chat && row.waId === messageRef.waId)?.id) ??
        null,
      forwardedTo: handedOn(messageRef),
    };
  };

  /*
   * The bank group's other messages: written there by someone outside the
   * office, and neither a deal's nor a request the desk already has. The bot
   * may read a transfer off one it did not take (a hand adds it), or it may be
   * talk. The days asked for, or the last two.
   */
  const others = bank
    ? await (async () => {
        const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        const rows = await db.groupMessage.findMany({
          where: {
            chat: bank.id,
            fromMe: false,
            createdAt: range ? { gte: range.from, lte: range.to } : { gte: since },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
        });
        const taken = new Set(kept.map((row) => row.id));
        const live = await db.bankRequest.findMany({
          where: { chat: bank.id, waId: { in: rows.map((row) => row.waId) }, status: { not: 'DISMISSED' } },
          select: { waId: true },
        });
        const asked = new Set(live.map((row) => row.waId));
        const channels = await transferChannels(db);
        return rows
          .filter((row) => !taken.has(row.id) && !asked.has(row.waId))
          .reverse()
          .map((row) => {
            const read = readTransferRequest(row.text, channels);
            return {
              id: row.id,
              source: 'message' as const,
              reference: bank.name,
              status: 'MESSAGE',
              kind: 'رسالة',
              at: row.createdAt,
              channel: read?.channel ?? null,
              account: read?.account ?? null,
              name: read?.name ?? null,
              phone: null,
              amount: read?.amount ?? 0n,
              currency: read?.currency ?? '',
              notes: null,
              by: row.senderName ?? (row.senderPhone ? `+${row.senderPhone}` : null),
              sentAt: null,
              sentBy: null,
              origin: {
                kind: 'external' as 'system' | 'external',
                name: row.senderName,
                phone: row.senderPhone,
              },
              messageId: row.id,
              forwardedTo: [] as { group: string; at: Date }[],
              text: row.text.slice(0, 200),
              hasMedia: Boolean(row.mediaId),
              readable: Boolean(read),
            };
          });
      })()
    : [];

  return {
    group: bank,
    waiting: lists.waiting.map(withMessage),
    sent: lists.sent.map(withMessage),
    range: lists.range?.map(withMessage) ?? null,
    others,
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
    void syncPayments('deal', id).catch(() => undefined);
  }

  log.info('A transfer was sent from the bank desk', { reference: result.reference });
  emitAsync('transaction.transferSent', { transactionId: id, proofId, actorId: actor.id });
  return result;
}

/**
 * What was cancelled on the desk, newest first: the counter's transfers that
 * were reversed — by whom, when and why — and the groups' requests taken off
 * the list, by whom and when (those taken off before this was kept say no one).
 */
export async function cancelledLog(actor: Actor, range: { from: Date; to: Date }, db: DbClient = prisma) {
  requireDesk(actor);
  // Every transfer reversed, whether or not it had reached the bank group yet.
  const [reversals, dismissed] = await Promise.all([
    db.transaction.findMany({
      where: {
        createdAt: { gte: range.from, lte: range.to },
        reversalOf: { payoutBankAmount: { gt: 0n } },
        // A deal moved to another teller is reversed and recorded again under them: not a cancellation.
        NOT: { reverseReason: { startsWith: 'نقل إلى ' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        reference: true,
        createdAt: true,
        reverseReason: true,
        createdBy: { select: { fullNameAr: true, fullNameEn: true } },
        reversalOf: { select: SELECT },
      },
    }),
    db.bankRequest.findMany({
      where: {
        status: 'DISMISSED',
        OR: [
          { dismissedAt: { gte: range.from, lte: range.to } },
          // Taken off before the time was kept: by when they were asked.
          { dismissedAt: null, createdAt: { gte: range.from, lte: range.to } },
        ],
      },
      orderBy: [{ dismissedAt: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    }),
  ]);
  const groups = await watched();
  const groupName = (chat: string) => groups.find((group) => group.id === chat)?.name ?? null;

  const rows = [
    ...reversals
      .filter((row) => row.reversalOf)
      .map((row) => {
        const deal = row.reversalOf!;
        return {
          key: `deal:${deal.id}`,
          kind: 'deal' as const,
          id: deal.id,
          reference: deal.reference,
          name: deal.recipientName ?? deal.counterpartyName ?? deal.customer?.fullNameAr ?? null,
          account: deal.payoutAccount,
          channel: deal.payoutBankChannel,
          amount: deal.payoutBankAmount,
          currency: deal.toCurrency,
          madeAt: deal.createdAt,
          /** Sent from the bank before it was reversed: the money had already left. */
          wasSent: Boolean(deal.transferConfirmedAt),
          cancelledAt: row.createdAt,
          cancelledBy: row.createdBy?.fullNameAr ?? null,
          cancelledByEn: row.createdBy?.fullNameEn ?? null,
          reason: row.reverseReason,
          reversal: row.reference,
          group: null as string | null,
        };
      }),
    ...dismissed.map((row) => ({
      key: `request:${row.id}`,
      kind: 'request' as const,
      id: row.id,
      reference: null as string | null,
      name: row.name ?? row.senderName,
      account: row.account,
      channel: row.channel,
      amount: row.amount,
      currency: row.currency,
      madeAt: row.createdAt,
      wasSent: false,
      cancelledAt: row.dismissedAt,
      cancelledBy: row.dismissedByName,
      cancelledByEn: row.dismissedByName,
      reason: null as string | null,
      reversal: null as string | null,
      group: groupName(row.chat),
    })),
  ].sort(
    (a, b) => (b.cancelledAt ?? b.madeAt).getTime() - (a.cancelledAt ?? a.madeAt).getTime(),
  );
  return { rows };
}

/**
 * The desk's pulse: a few figures that change whenever anything on the desk
 * does — a transfer recorded, sent, reversed or forwarded, a request asked or
 * taken off, a receipt kept or read, a word in the bank group. Asked every few
 * seconds by the open desk, so it shows what changed at once; each figure is
 * read from an index or a small table, so asking is cheap.
 */
export async function deskPulse(actor: Actor, db: DbClient = prisma): Promise<string> {
  requireDesk(actor);
  const bank = await bankGroup();
  const [waiting, newest, requests, requestSent, payments, forwards, tiktok, talk] = await Promise.all([
    db.transaction.count({ where: { status: 'PENDING_TRANSFER' } }),
    db.transaction.aggregate({ _max: { createdAt: true }, where: { status: { in: ['PENDING_TRANSFER', 'POSTED', 'REVERSED'] } } }),
    db.bankRequest.groupBy({ by: ['status'], _count: { _all: true }, _max: { createdAt: true } }),
    db.bankRequest.aggregate({ _max: { sentAt: true, dismissedAt: true } }),
    db.transferPayment.aggregate({ _count: { _all: true }, _max: { updatedAt: true } }),
    db.groupForward.aggregate({ _count: { _all: true }, _max: { createdAt: true } }),
    db.tiktokWithdrawal.aggregate({ _count: { _all: true }, _max: { sentAt: true, deletedAt: true, createdAt: true } }),
    bank ? db.groupMessage.aggregate({ where: { chat: bank.id }, _max: { createdAt: true } }) : null,
  ]);
  const at = (value: Date | null | undefined) => value?.getTime() ?? 0;
  return [
    waiting,
    at(newest._max.createdAt),
    ...requests
      .sort((a, b) => a.status.localeCompare(b.status))
      .map((row) => `${row.status}:${row._count._all}:${at(row._max.createdAt)}`),
    at(requestSent._max.sentAt),
    at(requestSent._max.dismissedAt),
    payments._count._all,
    at(payments._max.updatedAt),
    forwards._count._all,
    at(forwards._max.createdAt),
    tiktok._count._all,
    at(tiktok._max.sentAt),
    at(tiktok._max.deletedAt),
    at(tiktok._max.createdAt),
    at(talk?._max.createdAt),
  ].join('|');
}
