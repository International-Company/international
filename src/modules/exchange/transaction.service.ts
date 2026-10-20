import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { emitAsync } from '@/core/events/bus';
import { containsInsensitive } from '@/core/db/search';
import { nextReference } from '@/modules/sequence/reference';
import * as audit from '@/modules/audit/audit.service';
import * as drawers from '@/modules/drawers/drawer.service';
import { requireOpenDay } from './business-day.service';
import { cashOwnerFor } from '@/modules/treasury/shift.service';
import {
  TRANSACTION_TYPE_META,
  balancesFor,
  type BalanceSide,
  type TransactionStatus,
  type TransactionType,
} from './transaction-types';

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
   * How the customer paid. Omit for all cash, which is most of them.
   *
   * The two must sum to exactly `fromAmount`; a split allowed to disagree with
   * its own total leaks a fraction on every trade.
   */
  intake?: { cash: bigint; broker: bigint };
  /** Which of the broker's accounts the customer paid into. */
  intakeChannel?: string | null;
  /** How it is handed over. The mirror of `intake`, summing to `toAmount`. */
  payout?: { cash: bigint; bank: bigint };
  /** Where the transfer went. Recorded as given; see the schema for why. */
  payoutChannel?: string | null;
  /** Where the USDT was sent, for a withdrawal, and from which wallet. */
  payoutAddress?: string | null;
  payoutWalletId?: string | null;
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
  /*
   * An exchange with the same currency on both sides is a mistake. A remittance
   * with different currencies would be one: the customer hands over shekels and
   * the correspondent is owed shekels, and the gap between the two figures is
   * the margin rather than a conversion.
   */
  const isRemittance = input.type === 'REMITTANCE_OUT' || input.type === 'REMITTANCE_IN';
  if (!isRemittance && input.fromCurrency === input.toCurrency) {
    throw errors.precondition('Both sides are the same currency', 'errors.sameCurrencyPair');
  }
  if (isRemittance && input.fromCurrency !== input.toCurrency) {
    throw errors.precondition(
      'A remittance settles in one currency on both sides',
      'errors.remittanceCurrencyMismatch',
    );
  }

  const meta = TRANSACTION_TYPE_META[input.type];
  if (!meta) throw errors.precondition(`Unknown transaction type: ${input.type}`);

  /*
   * Which balances this type moves between, and how each side is divided when
   * it goes through more than one.
   *
   * A side pinned to one balance records the whole amount against it, except
   * the correspondent: a report adding these legs is adding up cash and broker
   * movements, and counting a correspondent debit among them would overstate
   * both. So that side records zeroes, and the movement below is what says
   * where the money actually went.
   */
  const balances = balancesFor(input.type);
  const split = (side: BalanceSide, total: bigint, given: { cash: bigint; broker: bigint } | undefined) => {
    if (side === 'CORRESPONDENT') return { cash: 0n, broker: 0n };
    if (side === 'CASH') return { cash: total, broker: 0n };
    return given ?? { cash: total, broker: 0n };
  };

  const intake = split(balances.intake, input.fromAmount, input.intake);
  const payout = split(
    balances.payout,
    input.toAmount,
    input.payout && { cash: input.payout.cash, broker: input.payout.bank },
  );

  // Exactly, not approximately. Checked here rather than at the caller because
  // this is the last place before the money moves, and every caller would
  // otherwise have to be trusted to have got it right.
  for (const [side, legs, total, key] of [
    [balances.intake, intake, input.fromAmount, 'errors.intakeDoesNotBalance'],
    [balances.payout, payout, input.toAmount, 'errors.payoutDoesNotBalance'],
  ] as const) {
    if (legs.cash < 0n || legs.broker < 0n) {
      throw errors.precondition('A leg cannot be negative', 'errors.amountNotPositive');
    }
    if (side === null && legs.cash + legs.broker !== total) {
      throw errors.precondition('The two legs must add up to their own total', key);
    }
  }

  /*
   * Money that goes through a bank belongs to a person who can be reached.
   *
   * A transfer leaves a trail with somebody else's name on it — the broker's —
   * and the office is the only party that knows whose money it was. Cash across
   * a counter is anonymous by its nature and always has been; a transfer is
   * not, and an office that cannot say who a transfer was for has a problem it
   * will only discover when somebody asks.
   *
   * So a leg through the broker, on either side, requires a name *and* a
   * number: a registered customer carrying a phone, or a name and phone typed
   * at the counter. Checked here rather than on each screen because there are
   * four ways to reach a broker leg — the machine, a split, the USDT counter
   * and a USDT sale — and a rule enforced in four places is a rule with three
   * places left to forget it.
   */
  const throughBroker = payout.broker > 0n || intake.broker > 0n;

  const recorded = await withTransaction(async (tx) => {
    let customerPhone: string | null = null;

    if (input.customerId) {
      const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (!customer) throw errors.notFound('Customer', input.customerId);
      if (customer.isBlocked) {
        throw errors.precondition(`Customer ${customer.code} is blocked`, 'errors.customerBlocked');
      }
      customerPhone = customer.phone;
    }

    if (throughBroker) {
      const named = input.customerId ?? input.counterpartyName?.trim();
      const reachable = customerPhone?.trim() || input.counterpartyPhone?.trim();

      if (!named) {
        throw errors.precondition(
          'A transfer needs the name of the person it is for',
          'errors.transferNeedsCustomer',
        );
      }
      if (!reachable) {
        throw errors.precondition(
          'A transfer needs a telephone number for the person it is for',
          'errors.transferNeedsPhone',
        );
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
        /*
         * A promise the branch made is pending until someone says it was kept;
         * a purely cash payout is finished the moment the notes cross the
         * counter. The branch makes two kinds of promise — a transfer through
         * the broker, and USDT sent from its own wallet — and both wait.
         *
         * Money coming *in* through the broker is not a promise the branch
         * made, so it does not make the trade pending. The teller who recorded
         * it is the person who checked it arrived.
         */
        status:
          payout.broker > 0n || input.type === 'USDT_SEND' ? 'PENDING_TRANSFER' : 'POSTED',
        branchId: input.branchId,
        customerId: input.customerId ?? null,
        fromCurrency: input.fromCurrency,
        fromAmount: input.fromAmount,
        toCurrency: input.toCurrency,
        toAmount: input.toAmount,
        intakeCashAmount: intake.cash,
        intakeBrokerAmount: intake.broker,
        intakeBankChannel: intake.broker > 0n ? (input.intakeChannel ?? null) : null,
        payoutCashAmount: payout.cash,
        payoutBankAmount: payout.broker,
        payoutBankChannel: payout.broker > 0n ? (input.payoutChannel ?? null) : null,
        payoutAddress: input.payoutAddress ?? null,
        payoutWalletId: input.payoutWalletId ?? null,
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
    /*
     * The two sides, named rather than assumed, and built the same way.
     *
     * A side pinned to one balance is one movement. A side that can go through
     * the till and the broker at once is two, and the account is carried on the
     * broker movement so his statement can be checked line by line.
     */
    /*
     * Whose cash this is. A teller on shift trades out of the drawer they
     * counted this morning and will hand back tonight; anyone else out of the
     * treasury. Resolved once, here, so both sides of the transaction agree.
     */
    const cashOwner = await cashOwnerFor(actor.id, tx);

    const sideLegs = (
      side: BalanceSide,
      currency: string,
      direction: 'IN' | 'OUT',
      total: bigint,
      legs: { cash: bigint; broker: bigint },
      account: string | null | undefined,
    ): drawers.Movement[] => {
      const common = {
        currency,
        direction,
        reason: 'TRANSACTION' as const,
        transactionId: row.id,
        businessDayId: day.id,
      };
      // The correspondent is the office's account, never a teller's.
      if (side) return [{ ...common, kind: side, amount: total, owner: side === 'CASH' ? cashOwner : undefined }];

      return [
        ...(legs.cash > 0n
          ? [{ ...common, kind: 'CASH' as const, amount: legs.cash, owner: cashOwner }]
          : []),
        // The broker's balance belongs to the office; a teller instructing a
        // transfer draws on the company's claim, not on their own drawer.
        ...(legs.broker > 0n
          ? [{ ...common, kind: 'BROKER' as const, amount: legs.broker, account: account ?? null }]
          : []),
      ];
    };

    await drawers.move(
      [
        ...sideLegs(
          balances.intake,
          input.fromCurrency,
          'IN',
          input.fromAmount,
          intake,
          input.intakeChannel,
        ),
        ...sideLegs(
          balances.payout,
          input.toCurrency,
          'OUT',
          input.toAmount,
          payout,
          input.payoutChannel,
        ),
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
        /*
         * A transfer is spelled out rather than folded into a total. Somebody
         * reading this line back — a manager, an auditor, the office itself a
         * year later — needs to see that part of it left through a bank, how
         * much, to which account, and for whom, without opening anything else.
         * A split that reads only as one figure hides exactly the half that is
         * worth asking about.
         */
        summaryEn: `${meta.nameEn} ${reference}: ${toDecimalString(input.fromAmount, 2)} ${input.fromCurrency} for ${toDecimalString(input.toAmount, 2)} ${input.toCurrency}${describeBroker(payout, intake, input, 'en')}`,
        summaryAr: `${meta.nameAr} ${reference}: ${toDecimalString(input.fromAmount, 2)} ${input.fromCurrency} مقابل ${toDecimalString(input.toAmount, 2)} ${input.toCurrency}${describeBroker(payout, intake, input, 'ar')}`,
        actor,
        after: {
          reference,
          type: input.type,
          fromAmount: input.fromAmount.toString(),
          fromCurrency: input.fromCurrency,
          toAmount: input.toAmount.toString(),
          toCurrency: input.toCurrency,
          rate: input.rate.toString(),
          // The bank half, named on its own so a search can find it.
          ...(payout.broker > 0n
            ? {
                payoutBankAmount: payout.broker.toString(),
                payoutCashAmount: payout.cash.toString(),
                payoutBankChannel: input.payoutChannel ?? null,
              }
            : {}),
          ...(intake.broker > 0n
            ? {
                intakeBrokerAmount: intake.broker.toString(),
                intakeCashAmount: intake.cash.toString(),
                intakeBankChannel: input.intakeChannel ?? null,
              }
            : {}),
          ...(payout.broker > 0n || intake.broker > 0n
            ? {
                counterpartyName: input.counterpartyName ?? null,
                counterpartyPhone: input.counterpartyPhone ?? null,
                customerId: input.customerId ?? null,
              }
            : {}),
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

    /*
     * The balances the original moved between, read from its type.
     *
     * The reversal has to return the money to where it actually came from. For
     * an exchange that is the payout legs on the row; for a remittance it is
     * the correspondent, which no column records — so it is derived from the
     * same function that decided it when the original was posted.
     */
    const mirrored = balancesFor(original.type as TransactionType);

    /*
     * How each side of the original was divided.
     *
     * A row recorded before a side could be split carries zeroes in both its
     * legs. Those were all cash — that was the only thing either side could be
     * — so they are read that way rather than restoring nothing at all. The
     * migration backfills them too; this is the belt to that pair of braces,
     * and it also covers anything written by a path that forgot to set them. It
     * cannot mistake a pinned side for one of those: those are read from the
     * type instead, and never reach this.
     */
    const divided = (cash: bigint, broker: bigint, total: bigint) =>
      cash + broker === total ? { cash, broker } : { cash: total, broker: 0n };

    const wasIntake = divided(
      original.intakeCashAmount,
      original.intakeBrokerAmount,
      original.fromAmount,
    );
    const wasPayout = divided(
      original.payoutCashAmount,
      original.payoutBankAmount,
      original.toAmount,
    );

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
         * The original's two sides, swapped. What the branch paid out it now
         * takes back in, and what it took in it now pays out — through the same
         * balances and the same broker accounts, or the two sides would never
         * cancel on his statement. Left at the default zero these would
         * disagree with the movements made below, and any report adding up legs
         * would quietly miss every reversal.
         */
        intakeCashAmount: wasPayout.cash,
        intakeBrokerAmount: wasPayout.broker,
        intakeBankChannel: original.payoutBankChannel,
        payoutCashAmount: wasIntake.cash,
        payoutBankAmount: wasIntake.broker,
        payoutBankChannel: original.intakeBankChannel,
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
     * Every leg goes back to the balance it came from.
     *
     * Returning a split wholly to cash would quietly move money between the
     * broker's account and the till — the totals would still balance, and both
     * balances would be wrong.
     */
    const undo = (
      side: BalanceSide,
      currency: string,
      direction: 'IN' | 'OUT',
      total: bigint,
      legs: { cash: bigint; broker: bigint },
      account: string | null,
    ): drawers.Movement[] => {
      const common = {
        currency,
        direction,
        reason: 'REVERSAL' as const,
        transactionId: reversal.id,
        businessDayId: day.id,
      };
      if (side) return [{ ...common, kind: side, amount: total }];

      return [
        ...(legs.cash > 0n ? [{ ...common, kind: 'CASH' as const, amount: legs.cash }] : []),
        ...(legs.broker > 0n
          ? [{ ...common, kind: 'BROKER' as const, amount: legs.broker, account }]
          : []),
      ];
    };

    await drawers.move(
      [
        ...undo(
          mirrored.payout,
          original.toCurrency,
          'IN',
          original.toAmount,
          wasPayout,
          original.payoutBankChannel,
        ),
        ...undo(
          mirrored.intake,
          original.fromCurrency,
          'OUT',
          original.fromAmount,
          wasIntake,
          original.intakeBankChannel,
        ),
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
      { counterpartyPhone: containsInsensitive(filter.search) },
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

    /*
     * A send the manager has not released cannot be confirmed as sent.
     *
     * Checked here rather than only on the screen because this is the last
     * place before the row claims the coins are gone, and a claim like that
     * must never rest on which button somebody happened to find.
     */
    if (row.approvalState === 'PENDING') {
      throw errors.precondition(
        'A manager has not released this send yet',
        'errors.withdrawalNotApproved',
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
      payoutWallet: { select: { id: true, label: true, labelAr: true, network: true } },
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

/**
 * The bank half of a posting, in words, for the audit line.
 *
 * Empty when nothing went through the broker, so an ordinary cash trade reads
 * exactly as it always did and the sentence only grows where there is
 * something to say.
 */
function describeBroker(
  payout: { cash: bigint; broker: bigint },
  intake: { cash: bigint; broker: bigint },
  input: RecordInput,
  locale: 'en' | 'ar',
): string {
  const parts: string[] = [];

  if (payout.broker > 0n) {
    const amount = `${toDecimalString(payout.broker, 2)} ${input.toCurrency}`;
    const where = input.payoutChannel ? ` → ${input.payoutChannel}` : '';
    parts.push(
      locale === 'en'
        ? `${amount} of it by transfer${where}`
        : `منها ${amount} حوالة${where}`,
    );
  }

  if (intake.broker > 0n) {
    const amount = `${toDecimalString(intake.broker, 2)} ${input.fromCurrency}`;
    const where = input.intakeChannel ? ` ← ${input.intakeChannel}` : '';
    parts.push(
      locale === 'en'
        ? `${amount} of it paid by transfer${where}`
        : `ودفع منها ${amount} حوالة${where}`,
    );
  }

  if (parts.length === 0) return '';

  const who = input.counterpartyName?.trim();
  const phone = input.counterpartyPhone?.trim();
  if (who) parts.push(locale === 'en' ? `for ${who}${phone ? ` (${phone})` : ''}` : `لـ${who}${phone ? ` (${phone})` : ''}`);

  return ` — ${parts.join(locale === 'en' ? ', ' : '، ')}`;
}
