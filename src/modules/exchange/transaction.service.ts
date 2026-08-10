import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { convert, toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { emitAsync } from '@/core/events/bus';
import { containsInsensitive } from '@/core/db/search';
import { nextReference } from '@/modules/sequence/reference';
import * as audit from '@/modules/audit/audit.service';
import * as drawers from '@/modules/drawers/drawer.service';
import { requireOpenDay } from './business-day.service';
import { TRANSACTION_TYPE_META, type TransactionStatus, type TransactionType } from './transaction-types';

/**
 * Recording what happened at the window.
 *
 * Both tools produce the same movement: one currency in, another out. So this
 * is one function rather than a posting rule per type — the machine and the USDT
 * counter differ in how they arrive at the two amounts, never in what happens to
 * the drawers afterwards.
 *
 * Recording is posting. The only correction is a reversal, which records the
 * opposite movement and leaves both rows standing: a receipt in a customer's
 * hand cannot be un-printed, so the books should not pretend otherwise.
 */

const log = createLogger('exchange:transaction');

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
  branchId?: string | null;
}

export interface RecordInput {
  type: TransactionType;
  branchId: string;
  /** What the customer hands over. */
  fromCurrency: string;
  fromAmount: bigint;
  /** What the customer takes away. */
  toCurrency: string;
  toAmount: bigint;
  /**
   * How that is handed over. Omit for all cash, which is most of them.
   *
   * The two must sum to exactly `toAmount`; a split allowed to disagree with
   * its own total leaks a fraction on every trade.
   */
  payout?: { cash: bigint; bank: bigint };
  /** Where the transfer went. Recorded as given; see the schema for why. */
  payoutChannel?: string | null;
  rate: bigint;
  rateId?: string | null;
  profitAmount?: bigint;
  customerId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  notes?: string | null;
}

export interface RecordedTransaction {
  id: string;
  reference: string;
  status: TransactionStatus;
}

/**
 * Records a transaction and moves both drawers, together or not at all.
 *
 * The two amounts arrive already priced. Deliberately: the machine and the
 * counter each have their own reason for the figure — a live quote in one case,
 * a price agreed with a waiting customer in the other — and re-deriving it here
 * would quietly overrule whichever of them was right.
 */
export async function record(
  input: RecordInput,
  actor: Actor,
  db: DbClient = prisma,
): Promise<RecordedTransaction> {
  if (input.fromAmount <= 0n || input.toAmount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }
  if (input.fromCurrency === input.toCurrency) {
    throw errors.precondition('Both sides are the same currency', 'errors.sameCurrencyPair');
  }

  const meta = TRANSACTION_TYPE_META[input.type];
  if (!meta) throw errors.precondition(`Unknown transaction type: ${input.type}`);

  // How the payout is split, defaulting to all cash.
  const payout = input.payout ?? { cash: input.toAmount, bank: 0n };

  if (payout.cash < 0n || payout.bank < 0n) {
    throw errors.precondition('A payout leg cannot be negative', 'errors.amountNotPositive');
  }
  // Exactly, not approximately. Checked here rather than at the caller because
  // this is the last place before the money moves, and every caller would
  // otherwise have to be trusted to have got it right.
  if (payout.cash + payout.bank !== input.toAmount) {
    throw errors.precondition(
      'The cash and bank legs must add up to the amount handed over',
      'errors.payoutDoesNotBalance',
    );
  }

  const recorded = await withTransaction(async (tx) => {
    if (input.customerId) {
      const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (!customer) throw errors.notFound('Customer', input.customerId);
      if (customer.isBlocked) {
        throw errors.precondition(`Customer ${customer.code} is blocked`, 'errors.customerBlocked');
      }
    }

    // Every transaction belongs to a day the manager opened, so a day can be
    // reviewed as a unit afterwards.
    const day = await requireOpenDay(input.branchId, new Date(), tx);

    const reference = await nextReference('TXN', tx);

    const row = await tx.transaction.create({
      data: {
        reference,
        type: input.type,
        // A bank leg is a promise until someone says it left; a purely cash
        // payout is finished the moment the notes cross the counter.
        status: payout.bank > 0n ? 'PENDING_TRANSFER' : 'POSTED',
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        fromCurrency: input.fromCurrency,
        fromAmount: input.fromAmount,
        toCurrency: input.toCurrency,
        toAmount: input.toAmount,
        payoutCashAmount: payout.cash,
        payoutBankAmount: payout.bank,
        payoutBankChannel: payout.bank > 0n ? (input.payoutChannel ?? null) : null,
        rate: input.rate,
        rateId: input.rateId ?? null,
        profitAmount: input.profitAmount ?? 0n,
        counterpartyName: input.counterpartyName ?? null,
        counterpartyPhone: input.counterpartyPhone ?? null,
        notes: input.notes ?? null,
        businessDayId: day.id,
        createdById: actor.id,
      },
    });

    /*
     * In and out in the same database transaction as the row itself. If either
     * balance cannot cover its leg this throws and nothing above survives.
     *
     * The bank leg is taken now, not when the transfer is confirmed. Deferring
     * it would let two pending transfers each promise money the account does
     * not hold — which is the entire guarantee the bank balance exists to give.
     * Confirmation therefore moves nothing; it only records that the promise
     * was kept.
     */
    await drawers.move(
      [
        {
          currency: input.fromCurrency,
          direction: 'IN',
          amount: input.fromAmount,
          reason: 'TRANSACTION',
          transactionId: row.id,
        },
        ...(payout.cash > 0n
          ? [
              {
                currency: input.toCurrency,
                kind: 'CASH' as const,
                direction: 'OUT' as const,
                amount: payout.cash,
                reason: 'TRANSACTION' as const,
                transactionId: row.id,
              },
            ]
          : []),
        ...(payout.bank > 0n
          ? [
              {
                currency: input.toCurrency,
                kind: 'BROKER' as const,
                direction: 'OUT' as const,
                amount: payout.bank,
                reason: 'TRANSACTION' as const,
                // The account the instruction named, kept on the movement so
                // the broker's statement can be checked line by line.
                account: input.payoutChannel ?? null,
                transactionId: row.id,
              },
            ]
          : []),
      ],
      actor,
      tx,
    );

    await audit.record(
      {
        action: 'POST',
        module: 'exchange',
        entityType: 'Transaction',
        entityId: row.id,
        summaryEn: `${meta.nameEn} ${reference}: ${toDecimalString(input.fromAmount, 2)} ${input.fromCurrency} for ${toDecimalString(input.toAmount, 2)} ${input.toCurrency}`,
        summaryAr: `${meta.nameAr} ${reference}: ${toDecimalString(input.fromAmount, 2)} ${input.fromCurrency} مقابل ${toDecimalString(input.toAmount, 2)} ${input.toCurrency}`,
        actor,
        after: {
          reference,
          type: input.type,
          fromAmount: input.fromAmount.toString(),
          fromCurrency: input.fromCurrency,
          toAmount: input.toAmount.toString(),
          toCurrency: input.toCurrency,
          rate: input.rate.toString(),
        },
      },
      tx,
    );

    // The row's own status, not a repeated literal. A payout with a bank leg
    // is pending, and a caller told otherwise would show the teller a finished
    // transaction that the manager still has to confirm.
    return { id: row.id, reference, status: row.status as TransactionStatus };
  }, db);

  emitAsync('transaction.posted', {
    transactionId: recorded.id,
    reference: recorded.reference,
    type: input.type,
    actorId: actor.id,
  });

  log.info('Transaction recorded', { reference: recorded.reference, type: input.type });

  return recorded;
}

/**
 * Undoes a posted transaction by recording its mirror image.
 *
 * Checked here and not only at the route. A teller records and posts their own
 * work, so undoing it is the manager's control over it — the one place the two
 * roles differ on a transaction, and too important to rest on a single caller
 * remembering to guard it.
 */
export async function reverse(
  id: string,
  reason: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ reversalId: string; reference: string }> {
  if (!reason.trim()) {
    throw errors.validation([{ path: 'reason', message: 'A reason is required to reverse' }]);
  }
  if (!actor.permissions.includes('exchange.transaction.reverse')) {
    throw errors.forbidden('exchange.transaction.reverse');
  }

  const result = await withTransaction(async (tx) => {
    const original = await tx.transaction.findUnique({ where: { id } });
    if (!original) throw errors.notFound('Transaction', id);

    // A transfer still awaiting confirmation is exactly the case where undoing
    // is most useful — the mistake is caught before the money leaves the bank —
    // so it is reversible too. Only an already-reversed one is not.
    if (original.status !== 'POSTED' && original.status !== 'PENDING_TRANSFER') {
      throw errors.conflict('Only a posted transaction can be reversed', 'errors.notPosted');
    }
    if (original.reversalOfId) {
      throw errors.conflict('A reversal cannot itself be reversed', 'errors.cannotReverseReversal');
    }

    const existing = await tx.transaction.findFirst({ where: { reversalOfId: id } });
    if (existing) {
      throw errors.conflict('This transaction has already been reversed', 'errors.alreadyReversed');
    }

    const day = await requireOpenDay(original.branchId, new Date(), tx);
    const reference = await nextReference('TXN', tx);

    // The mirror: what went out comes back, what came in goes away.
    const reversal = await tx.transaction.create({
      data: {
        reference,
        type: original.type,
        status: 'POSTED',
        branchId: original.branchId,
        customerId: original.customerId,
        fromCurrency: original.toCurrency,
        fromAmount: original.toAmount,
        toCurrency: original.fromCurrency,
        toAmount: original.fromAmount,
        /*
         * A reversal hands back what the customer handed over, and it hands it
         * back in cash — that is the movement made below. Left at the default
         * zero these two would disagree with that movement, and any report
         * adding up payout legs would quietly miss every reversal.
         */
        payoutCashAmount: original.fromAmount,
        payoutBankAmount: 0n,
        rate: original.rate,
        profitAmount: -original.profitAmount,
        counterpartyName: original.counterpartyName,
        counterpartyPhone: original.counterpartyPhone,
        notes: `Reversal of ${original.reference}: ${reason}`,
        reversalOfId: original.id,
        reverseReason: reason,
        businessDayId: day.id,
        createdById: actor.id,
      },
    });

    /*
     * What went out comes back to the balance it went out of.
     *
     * Returning a split payout wholly to cash would quietly move money from the
     * bank account into the till — the totals would still balance, and the two
     * balances would both be wrong.
     */
    /*
     * A row recorded before payouts could be split carries zeroes in both legs.
     * Those were all cash — that was the only thing a payout could be — so they
     * are read that way rather than restoring nothing at all. The migration
     * backfills them too; this is the belt to that pair of braces, and it also
     * covers anything written by a path that forgot to set the legs.
     */
    const legs =
      original.payoutCashAmount + original.payoutBankAmount === original.toAmount
        ? { cash: original.payoutCashAmount, bank: original.payoutBankAmount }
        : { cash: original.toAmount, bank: 0n };

    await drawers.move(
      [
        ...(legs.cash > 0n
          ? [
              {
                currency: original.toCurrency,
                kind: 'CASH' as const,
                direction: 'IN' as const,
                amount: legs.cash,
                reason: 'REVERSAL' as const,
                transactionId: reversal.id,
              },
            ]
          : []),
        ...(legs.bank > 0n
          ? [
              {
                currency: original.toCurrency,
                kind: 'BROKER' as const,
                direction: 'IN' as const,
                amount: legs.bank,
                reason: 'REVERSAL' as const,
                // Back through the same account it went out of, or the two
                // sides would never cancel on his statement.
                account: original.payoutBankChannel,
                transactionId: reversal.id,
              },
            ]
          : []),
        {
          currency: original.fromCurrency,
          direction: 'OUT',
          amount: original.fromAmount,
          reason: 'REVERSAL',
          transactionId: reversal.id,
        },
      ],
      actor,
      tx,
    );

    await tx.transaction.update({ where: { id }, data: { status: 'REVERSED' } });

    await audit.record(
      {
        action: 'REVERSE',
        module: 'exchange',
        entityType: 'Transaction',
        entityId: id,
        summaryEn: `Reversed ${original.reference} with ${reference}: ${reason}`,
        summaryAr: `عكس العملية ${original.reference} بالعملية ${reference}: ${reason}`,
        actor,
        after: { reversal: reference, reason },
      },
      tx,
    );

    return { reversalId: reversal.id, reference, originalReference: original.reference };
  }, db);

  emitAsync('transaction.reversed', {
    transactionId: id,
    reversalId: result.reversalId,
    actorId: actor.id,
  });

  log.warn('Transaction reversed', { original: result.originalReference, reversal: result.reference });

  return { reversalId: result.reversalId, reference: result.reference };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface TransactionFilter {
  status?: TransactionStatus;
  type?: TransactionType;
  createdById?: string;
  from?: Date;
  to?: Date;
  search?: string;
  page?: number;
  pageSize?: number;
}

function buildWhere(filter: TransactionFilter, actor: Actor): Prisma.TransactionWhereInput {
  const where: Prisma.TransactionWhereInput = {};

  // Without `viewAll`, a teller sees only their own work.
  if (!actor.permissions.includes('exchange.transaction.viewAll')) {
    where.createdById = actor.id;
  } else if (filter.createdById) {
    where.createdById = filter.createdById;
  }

  if (filter.status) where.status = filter.status;
  if (filter.type) where.type = filter.type;

  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }

  if (filter.search) {
    where.OR = [
      { reference: containsInsensitive(filter.search) },
      { counterpartyName: containsInsensitive(filter.search) },
      { customer: { fullNameEn: containsInsensitive(filter.search) } },
      { customer: { fullNameAr: containsInsensitive(filter.search) } },
      { customer: { code: containsInsensitive(filter.search) } },
    ];
  }

  return where;
}

/**
 * Editing the parts of a transaction that never moved money.
 *
 * The note, who the other party was, which customer it belongs to. None of
 * these produced a drawer movement, so changing them cannot make a balance
 * disagree with its history — and a name typed wrong at the window should be
 * fixable without reversing a correct trade.
 *
 * The amounts, the rate and the currencies are not here on purpose. Editing
 * those in place would leave the movements saying one thing and the transaction
 * another: `verifyBalances()` would still pass, because the movements would be
 * untouched, while the row lied about what it had done. A silent wrong answer
 * that survives every check is worse than a visible one. `correct` exists for
 * that, and moves the money to match.
 *
 * A reversal row is refused: its note carries the reason it was reversed, and
 * that is not a field to rewrite.
 */
export async function updateDetails(
  id: string,
  patch: {
    notes?: string | null;
    counterpartyName?: string | null;
    counterpartyPhone?: string | null;
    customerId?: string | null;
  },
  actor: Actor,
  db: DbClient = prisma,
) {
  if (!actor.permissions.includes('exchange.transaction.edit')) {
    throw errors.forbidden('exchange.transaction.edit');
  }

  const original = await db.transaction.findUnique({ where: { id } });
  if (!original) throw errors.notFound('Transaction', id);

  if (original.reversalOfId) {
    throw errors.conflict(
      'A reversal carries the reason it was made; it is not edited',
      'errors.cannotEditReversal',
    );
  }

  if (patch.customerId) {
    const customer = await db.customer.findUnique({ where: { id: patch.customerId } });
    if (!customer) throw errors.notFound('Customer', patch.customerId);
    if (customer.isBlocked) {
      throw errors.precondition(`Customer ${customer.code} is blocked`, 'errors.customerBlocked');
    }
  }

  const updated = await db.transaction.update({
    where: { id },
    data: {
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.counterpartyName !== undefined
        ? { counterpartyName: patch.counterpartyName }
        : {}),
      ...(patch.counterpartyPhone !== undefined
        ? { counterpartyPhone: patch.counterpartyPhone }
        : {}),
      ...(patch.customerId !== undefined ? { customerId: patch.customerId } : {}),
    },
  });

  await audit.record({
    action: 'UPDATE',
    module: 'exchange',
    entityType: 'Transaction',
    entityId: id,
    summaryEn: `Edited the details of ${original.reference}`,
    summaryAr: `تعديل بيانات العملية ${original.reference}`,
    actor,
    before: {
      notes: original.notes,
      counterpartyName: original.counterpartyName,
      counterpartyPhone: original.counterpartyPhone,
      customerId: original.customerId,
    },
    after: {
      notes: updated.notes,
      counterpartyName: updated.counterpartyName,
      counterpartyPhone: updated.counterpartyPhone,
      customerId: updated.customerId,
    },
  });

  log.info('Transaction details edited', { reference: original.reference });

  return { id: updated.id, reference: updated.reference };
}

/**
 * Correcting an amount: reverse the original and post the right one, together.
 *
 * This is what "editing the amount" has to be in a system where the money has
 * already moved. Both halves run in one database transaction, so the branch is
 * never left holding a reversal with no replacement, and all three rows stay on
 * the record — the customer's receipt still matches something.
 *
 * The price is kept, not re-quoted. The case this exists for is a teller typing
 * 100 for 1,000; re-pricing at today's board would silently change what the
 * customer was charged, which is a different and much worse mistake than the
 * one being fixed. So the corrected payout is the same rate applied to the
 * corrected amount, and the split across till and bank keeps its proportion.
 */
export async function correct(
  id: string,
  input: { fromAmount: bigint; reason: string },
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ id: string; reference: string; status: TransactionStatus }> {
  if (!actor.permissions.includes('exchange.transaction.edit')) {
    throw errors.forbidden('exchange.transaction.edit');
  }
  if (input.fromAmount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }
  if (input.reason.trim().length < 3) {
    throw errors.validation([{ path: 'reason', message: 'Say what was wrong' }]);
  }

  return withTransaction(async (tx) => {
    const original = await tx.transaction.findUnique({ where: { id } });
    if (!original) throw errors.notFound('Transaction', id);

    if (original.fromAmount === input.fromAmount) {
      throw errors.precondition('That is the amount already recorded', 'errors.nothingToCorrect');
    }

    const target = await tx.currency.findUnique({ where: { code: original.toCurrency } });
    const decimals = target?.decimals ?? 2;

    // The same arithmetic that produced the original, at the same rate.
    const toAmount = convert(input.fromAmount, original.rate, decimals);

    /*
     * Profit is linear in the amount at a fixed rate, so it scales exactly.
     * Integer division truncates the last unit; that is a reporting figure, and
     * a rounded margin is better than one recomputed against a board that has
     * moved since.
     */
    const profitAmount = (original.profitAmount * input.fromAmount) / original.fromAmount;

    /*
     * The payout keeps its shape. The bank share is taken first and the till
     * takes the remainder, so the two still sum to exactly the new total no
     * matter how the division rounds.
     */
    const bank =
      original.toAmount === 0n
        ? 0n
        : (toAmount * original.payoutBankAmount) / original.toAmount;

    // Reverse first: the balances must be back before the replacement asks them
    // to cover it, or a correction upward could be refused for want of money
    // the original is still holding.
    await reverse(id, `Correction: ${input.reason.trim()}`, actor, tx);

    const replacement = await record(
      {
        type: original.type as TransactionType,
        branchId: original.branchId,
        customerId: original.customerId,
        fromCurrency: original.fromCurrency,
        fromAmount: input.fromAmount,
        toCurrency: original.toCurrency,
        toAmount,
        payout: { cash: toAmount - bank, bank },
        payoutChannel: original.payoutBankChannel,
        rate: original.rate,
        rateId: original.rateId,
        profitAmount,
        counterpartyName: original.counterpartyName,
        counterpartyPhone: original.counterpartyPhone,
        notes: `Correction of ${original.reference}: ${input.reason.trim()}`,
      },
      actor,
      tx,
    );

    await audit.record(
      {
        action: 'UPDATE',
        module: 'exchange',
        entityType: 'Transaction',
        entityId: id,
        summaryEn: `Corrected ${original.reference}: ${toDecimalString(original.fromAmount, 2)} → ${toDecimalString(input.fromAmount, 2)} ${original.fromCurrency}, reposted as ${replacement.reference}`,
        summaryAr: `تصحيح العملية ${original.reference}: ${toDecimalString(original.fromAmount, 2)} ← ${toDecimalString(input.fromAmount, 2)} ${original.fromCurrency}، أُعيد تسجيلها ${replacement.reference}`,
        actor,
        before: { fromAmount: original.fromAmount.toString(), toAmount: original.toAmount.toString() },
        after: { fromAmount: input.fromAmount.toString(), toAmount: toAmount.toString() },
      },
      tx,
    );

    log.info('Transaction corrected', {
      original: original.reference,
      replacement: replacement.reference,
    });

    return replacement;
  }, db);
}

/**
 * Records that a promised bank transfer actually left.
 *
 * Deliberately moves no money. The bank leg was taken out of the balance the
 * moment it was promised, because a promise that has not yet reduced the
 * balance is one two tellers can both make against the same funds. All that is
 * outstanding by the time anyone reaches this function is proof, so this
 * supplies proof and nothing else.
 *
 * Not the teller's to press. Confirming your own promise is the same person
 * saying both halves, which is the one thing the separation is for.
 */
export async function confirmTransfer(
  id: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ id: string; reference: string; status: TransactionStatus }> {
  if (!actor.permissions.includes('exchange.transfer.confirm')) {
    throw errors.forbidden('exchange.transfer.confirm');
  }

  const result = await withTransaction(async (tx) => {
    const row = await tx.transaction.findUnique({ where: { id } });
    if (!row) throw errors.notFound('Transaction', id);

    if (row.status !== 'PENDING_TRANSFER') {
      throw errors.conflict(
        'This transaction is not waiting on a transfer',
        'errors.notPendingTransfer',
      );
    }

    return tx.transaction.update({
      where: { id },
      data: {
        status: 'POSTED',
        transferConfirmedAt: new Date(),
        transferConfirmedById: actor.id,
      },
      select: { id: true, reference: true, status: true, toCurrency: true, payoutBankAmount: true },
    });
  }, db);

  await audit.record({
    action: 'UPDATE',
    module: 'exchange',
    entityType: 'Transaction',
    entityId: result.id,
    summaryEn: `Confirmed the bank transfer for ${result.reference}: ${toDecimalString(result.payoutBankAmount, 2)} ${result.toCurrency} left the account`,
    summaryAr: `تأكيد الحوالة البنكية للعملية ${result.reference}: ${toDecimalString(result.payoutBankAmount, 2)} ${result.toCurrency} خرجت من الحساب`,
    actor,
    after: { status: 'POSTED' },
  });

  log.info('Bank transfer confirmed', { reference: result.reference });

  return { id: result.id, reference: result.reference, status: result.status as TransactionStatus };
}

export async function list(filter: TransactionFilter, actor: Actor, db: DbClient = prisma) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));
  const where = buildWhere(filter, actor);

  const [rows, total] = await Promise.all([
    db.transaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        customer: { select: { id: true, code: true, fullNameEn: true, fullNameAr: true } },
        createdBy: { select: { fullNameEn: true, fullNameAr: true } },
        reversalOf: { select: { id: true, reference: true } },
        reversedBy: { select: { id: true, reference: true } },
      },
    }),
    db.transaction.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}

/** The teller's own recent work, for reprinting a receipt from the tool itself. */
export async function recentFor(
  actor: Actor,
  options: { limit?: number; type?: TransactionType } = {},
  db: DbClient = prisma,
) {
  return db.transaction.findMany({
    where: { createdById: actor.id, ...(options.type ? { type: options.type } : {}) },
    orderBy: { createdAt: 'desc' },
    take: Math.min(options.limit ?? 8, 50),
    select: {
      id: true,
      reference: true,
      type: true,
      status: true,
      fromCurrency: true,
      fromAmount: true,
      toCurrency: true,
      toAmount: true,
      createdAt: true,
      counterpartyName: true,
      customer: { select: { fullNameEn: true, fullNameAr: true } },
    },
  });
}

export async function getById(id: string, actor: Actor, db: DbClient = prisma) {
  const transaction = await db.transaction.findUnique({
    where: { id },
    include: {
      customer: true,
      createdBy: { select: { id: true, fullNameEn: true, fullNameAr: true, username: true } },
      branch: true,
      receipts: true,
      chainTransaction: true,
      depositRequest: { select: { id: true, reference: true } },
      reversalOf: { select: { id: true, reference: true } },
      reversedBy: { select: { id: true, reference: true } },
      movements: {
        orderBy: { createdAt: 'asc' },
        include: { drawer: { select: { currencyCode: true, nameEn: true, nameAr: true } } },
      },
    },
  });
  if (!transaction) throw errors.notFound('Transaction', id);

  if (
    !actor.permissions.includes('exchange.transaction.viewAll') &&
    transaction.createdById !== actor.id
  ) {
    throw errors.forbidden('exchange.transaction.viewAll');
  }

  return transaction;
}

/** Today's totals, for the manager's oversight screen. */
export async function todaySummary(db: DbClient = prisma) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const [byType, profit, reversals] = await Promise.all([
    db.transaction.groupBy({
      by: ['type'],
      where: { status: 'POSTED', createdAt: { gte: start } },
      _count: { _all: true },
    }),
    db.transaction.aggregate({
      where: { status: 'POSTED', createdAt: { gte: start } },
      _sum: { profitAmount: true },
    }),
    db.transaction.count({ where: { status: 'REVERSED', createdAt: { gte: start } } }),
  ]);

  return {
    byType: byType.map((entry) => ({ type: entry.type, count: entry._count._all })),
    profit: profit._sum.profitAmount ?? 0n,
    reversals,
  };
}

/** Whether the machine or the counter may run at all right now. */
export async function requireBranch(actor: Actor): Promise<string> {
  if (actor.branchId) return actor.branchId;

  const branch = await prisma.branch.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } });
  if (!branch) throw errors.precondition('No branch is configured', 'errors.noBranch');
  return branch.id;
}
