import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { nextReference } from '@/modules/sequence/reference';
import * as audit from '@/modules/audit/audit.service';
import * as notifications from '@/modules/notifications/notifications.service';
import * as settings from '@/modules/settings/settings.service';
import * as cutoff from '@/modules/ledger/cutoff.service';
import { getActiveRate, quoteExchange, type RateChannel } from './rates.service';
import { currentOpenDay } from './business-day.service';

/**
 * الاستثناء السعري — breaking the board for one deal, before it is struck.
 *
 * A teller meets a customer who will walk over an agura and asks to shade the
 * price. The manager says yes or no **while looking at what the office pays for
 * the currency**, so the question he answers is "are we still above cost?"
 * rather than "does that seem reasonable?".
 *
 * What makes it safe is not the approval. It is that the approval cannot
 * outlive the moment it was given — an approved price with no leash quietly
 * becomes a standing discount, spent tomorrow on a different customer at a
 * different amount by a different teller, and nobody would ever see it happen.
 * So it expires in minutes, names the pair and the channel and caps the amount,
 * can be spent once, and is stamped on the deal it was spent on. Every one of
 * those is checked again at the instant the money moves, not at the moment the
 * button was pressed.
 *
 * Two things this deliberately is not:
 *
 *   - **It is not an approval of the transaction.** The price is approved
 *     before the deal; the deal still posts the moment it is recorded. The
 *     drafts-and-approvals system that was deleted is not coming back.
 *   - **It is not a rate the browser sends.** The teller sends this row's id
 *     and nothing else. The server reads the rate from here, so a screen left
 *     open, edited, or replayed cannot name its own price.
 *
 * ## Which way is "worse"
 *
 * A quote is expressed as: one unit of `fromCurrency` buys `rate` units of
 * `toCurrency`. The office hands out the `toCurrency`, so **a higher rate is
 * always worse for the office**, in both directions of a pair. That single fact
 * is what lets one comparison serve everywhere here: a request must be above
 * the board (below it needs no permission), and the deal is above cost while it
 * stays below the cost rate.
 */

const log = createLogger('exchange:price-exception');

export const EXCEPTION_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'USED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

const ONE = 100000000n;

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
  branchId?: string | null;
}

export const REQUEST_PERMISSION = 'exchange.priceException.request';
export const APPROVE_PERMISSION = 'exchange.priceException.approve';

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * What the office carries this trade at, as a rate.
 *
 * Derived from the cut-off rates rather than invented here, because those are
 * the numbers the manager already approves and the ledger already values the
 * position with. Anything else would give him a second cost to argue with.
 *
 * Both currencies are held in base-currency terms, so the cost of turning one
 * into the other is the ratio between them.
 */
export async function costRateFor(
  fromCurrency: string,
  toCurrency: string,
  db: DbClient = prisma,
): Promise<bigint | null> {
  const rates = await cutoff.ratesOn(new Date(), db);
  const from = rates.get(fromCurrency);
  const to = rates.get(toCurrency);
  // No cut-off means the manager has not said what this currency is worth, and
  // a cost invented in its absence would be worse than no cost at all.
  if (!from || !to || to.rate === 0n) return null;
  return (from.rate * ONE) / to.rate;
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

export interface RequestInput {
  fromCurrency: string;
  toCurrency: string;
  channel: RateChannel;
  /** The most the customer will hand over on this leg. */
  maxFromAmount: bigint;
  /** The price the teller wants, as `toCurrency` per one `fromCurrency`. */
  requestedRate: bigint;
  reason?: string | null;
}

export async function request(input: RequestInput, actor: Actor, db: DbClient = prisma) {
  if (!actor.permissions.includes(REQUEST_PERMISSION)) {
    throw errors.forbidden(REQUEST_PERMISSION);
  }
  if (!actor.branchId) {
    throw errors.precondition('No branch is assigned', 'errors.noBranch');
  }
  if (input.maxFromAmount <= 0n || input.requestedRate <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }
  if (input.fromCurrency === input.toCurrency) {
    throw errors.precondition('Both sides are the same currency', 'errors.sameCurrencyPair');
  }

  // Priced through the same path the deal will take, so the board figure the
  // manager sees is the one the teller was actually quoted.
  const board = await quoteExchange(
    input.fromCurrency,
    input.toCurrency,
    input.maxFromAmount,
    input.channel,
    db,
  );

  /*
   * A price better than the board needs nobody's permission, and letting one
   * through here would fill the manager's screen with requests that are not
   * requests — which is how a queue that matters becomes one that is skimmed.
   */
  if (input.requestedRate <= board.rate) {
    throw errors.precondition(
      'That is at or better than the board — no approval is needed',
      'errors.exceptionNotAConcession',
    );
  }

  const [reference, day] = await Promise.all([
    nextReference('PEX', db),
    currentOpenDay(actor.branchId, db, actor),
  ]);

  const row = await db.priceException.create({
    data: {
      reference,
      status: 'PENDING',
      branchId: actor.branchId,
      businessDayId: day?.id ?? null,
      requestedById: actor.id,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      channel: input.channel,
      maxFromAmount: input.maxFromAmount,
      boardRate: board.rate,
      requestedRate: input.requestedRate,
      reason: input.reason?.trim() || null,
    },
  });

  await notifications.notify(
    {
      severity: 'WARNING',
      eventKey: 'exchange.priceException.requested',
      module: 'exchange',
      titleEn: 'A teller is asking to break a price',
      titleAr: 'طلب كسر سعر',
      bodyEn: `${actor.name} on ${input.fromCurrency}/${input.toCurrency} — ${reference}`,
      bodyAr: `${actor.name} على ${input.fromCurrency}/${input.toCurrency} — ${reference}`,
      entityType: 'PriceException',
      entityId: row.id,
      link: '/manage/exceptions',
      createdById: actor.id,
    },
    { permission: APPROVE_PERMISSION, branchId: actor.branchId, exceptUserId: actor.id },
    db,
  );

  await audit.record(
    {
      action: 'CREATE',
      module: 'exchange',
      entityType: 'PriceException',
      entityId: row.id,
      summaryEn: `Asked for ${input.fromCurrency}/${input.toCurrency} at ${toDecimalString(input.requestedRate, 6)} against a board of ${toDecimalString(board.rate, 6)}`,
      summaryAr: `طلب سعر ${toDecimalString(input.requestedRate, 6)} على ${input.fromCurrency}/${input.toCurrency} واللوحة ${toDecimalString(board.rate, 6)}`,
      actor,
    },
    db,
  );

  log.info('Price exception requested', { reference, pair: `${input.fromCurrency}/${input.toCurrency}` });
  return row;
}

// ---------------------------------------------------------------------------
// Deciding
// ---------------------------------------------------------------------------

export interface DecisionInput {
  approve: boolean;
  /** What the manager actually grants. Defaults to what was asked. */
  rate?: bigint;
  note?: string | null;
}

export async function decide(
  id: string,
  input: DecisionInput,
  actor: Actor,
  db: DbClient = prisma,
) {
  if (!actor.permissions.includes(APPROVE_PERMISSION)) {
    throw errors.forbidden(APPROVE_PERMISSION);
  }

  const minutes = await settings.getNumber('exchange.priceException.minutes', db);

  return withTransaction(async (tx) => {
    const row = await tx.priceException.findUnique({ where: { id } });
    if (!row) throw errors.notFound('PriceException', id);
    if (row.status !== 'PENDING') {
      throw errors.conflict('This request has already been decided', 'errors.exceptionDecided');
    }
    /*
     * Nobody approves their own. The whole control is that a second person
     * looked at the cost, and a manager who is also serving customers would
     * otherwise be able to grant himself a price with one click.
     */
    if (row.requestedById === actor.id) {
      throw errors.precondition(
        'The person who asked cannot be the person who approves',
        'errors.exceptionSamePerson',
      );
    }

    if (!input.approve) {
      const rejected = await tx.priceException.update({
        where: { id },
        data: {
          status: 'REJECTED',
          approvedById: actor.id,
          decidedAt: new Date(),
          decisionNote: input.note?.trim() || null,
        },
      });
      await announce(rejected, actor, tx);
      return rejected;
    }

    const granted = input.rate ?? row.requestedRate;
    if (granted <= 0n) {
      throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
    }
    /*
     * A manager may grant less than was asked but never more. Granting a worse
     * price than the teller asked for would be the office bidding against
     * itself, and it is far more likely to be a typo.
     */
    if (granted > row.requestedRate) {
      throw errors.precondition(
        'Cannot grant a worse price than the one asked for',
        'errors.exceptionWorseThanAsked',
      );
    }
    if (granted <= row.boardRate) {
      throw errors.precondition(
        'That is at or better than the board — no approval is needed',
        'errors.exceptionNotAConcession',
      );
    }

    const approved = await tx.priceException.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedById: actor.id,
        approvedRate: granted,
        // Frozen at the decision, so the record says what he was looking at
        // when he said yes rather than what the cost happens to be later.
        costRate: await costRateFor(row.fromCurrency, row.toCurrency, tx),
        decidedAt: new Date(),
        decisionNote: input.note?.trim() || null,
        expiresAt: new Date(Date.now() + Math.max(1, minutes) * 60_000),
      },
    });

    await announce(approved, actor, tx);
    return approved;
  }, db);
}

/** Tells the teller, and writes it down. */
async function announce(
  row: {
    id: string;
    reference: string;
    status: string;
    requestedById: string;
    fromCurrency: string;
    toCurrency: string;
    approvedRate: bigint | null;
  },
  actor: Actor,
  tx: DbClient,
): Promise<void> {
  const granted = row.status === 'APPROVED';

  await notifications.notify(
    {
      severity: granted ? 'SUCCESS' : 'INFO',
      eventKey: `exchange.priceException.${granted ? 'approved' : 'rejected'}`,
      module: 'exchange',
      titleEn: granted ? 'Your price was approved' : 'Your price was refused',
      titleAr: granted ? 'وُوفق على السعر' : 'رُفض السعر',
      bodyEn: granted
        ? `${row.reference} — ${row.fromCurrency}/${row.toCurrency} at ${toDecimalString(row.approvedRate ?? 0n, 6)}`
        : `${row.reference} — ${row.fromCurrency}/${row.toCurrency}`,
      bodyAr: granted
        ? `${row.reference} — ${row.fromCurrency}/${row.toCurrency} بسعر ${toDecimalString(row.approvedRate ?? 0n, 6)}`
        : `${row.reference} — ${row.fromCurrency}/${row.toCurrency}`,
      entityType: 'PriceException',
      entityId: row.id,
      link: '/counter/machine',
      createdById: actor.id,
    },
    { userIds: [row.requestedById] },
    tx,
  );

  await audit.record(
    {
      action: 'UPDATE',
      module: 'exchange',
      entityType: 'PriceException',
      entityId: row.id,
      summaryEn: granted
        ? `Approved ${row.reference} at ${toDecimalString(row.approvedRate ?? 0n, 6)}`
        : `Refused ${row.reference}`,
      summaryAr: granted
        ? `وافق على ${row.reference} بسعر ${toDecimalString(row.approvedRate ?? 0n, 6)}`
        : `رفض ${row.reference}`,
      actor,
    },
    tx,
  );
}

/** The teller withdraws his own request — the customer left. */
export async function cancel(id: string, actor: Actor, db: DbClient = prisma) {
  const row = await db.priceException.findUnique({ where: { id } });
  if (!row) throw errors.notFound('PriceException', id);
  if (row.requestedById !== actor.id) throw errors.forbidden(REQUEST_PERMISSION);
  if (row.status !== 'PENDING' && row.status !== 'APPROVED') {
    throw errors.conflict('This request has already been decided', 'errors.exceptionDecided');
  }

  return db.priceException.update({ where: { id }, data: { status: 'CANCELLED' } });
}

// ---------------------------------------------------------------------------
// Spending it
// ---------------------------------------------------------------------------

export interface ClaimInput {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  channel: RateChannel;
  /** What the customer is actually handing over on this leg. */
  fromAmount: bigint;
}

/**
 * Checks every leash and takes the approval out of circulation, in one step.
 *
 * Called from inside the transaction that records the deal, and it claims the
 * row before the money moves rather than after: two tellers pressing record at
 * the same instant would otherwise both read `APPROVED` and both trade on it.
 * The claim is a conditional update — it only matches a row still approved — so
 * whichever request loses gets no rows back and is refused.
 *
 * Returns the rate the server will use — and the board it was granted against,
 * so the caller can work out what the concession cost while it still knows the
 * amount of the leg. The caller never had a rate of its own.
 */
export async function claim(
  input: ClaimInput,
  actor: Actor,
  tx: DbClient,
): Promise<{ rate: bigint; boardRate: bigint }> {
  const row = await tx.priceException.findUnique({ where: { id: input.id } });
  if (!row) throw errors.notFound('PriceException', input.id);

  const refuse = (message: string, key: string) => errors.precondition(message, key);

  if (row.status !== 'APPROVED' || row.approvedRate === null) {
    throw refuse('That price was not approved', 'errors.exceptionNotApproved');
  }
  // Given to a person standing in front of a customer, not to the branch.
  if (row.requestedById !== actor.id) {
    throw refuse('That approval belongs to another teller', 'errors.exceptionNotYours');
  }
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    await tx.priceException.update({ where: { id: row.id }, data: { status: 'EXPIRED' } });
    throw refuse('That approval has expired', 'errors.exceptionExpired');
  }
  if (row.fromCurrency !== input.fromCurrency || row.toCurrency !== input.toCurrency) {
    throw refuse('That approval was for a different pair', 'errors.exceptionWrongPair');
  }
  if (row.channel !== input.channel) {
    throw refuse('That approval was for a different way of paying', 'errors.exceptionWrongChannel');
  }
  if (input.fromAmount > row.maxFromAmount) {
    throw refuse('That is more than the approval covers', 'errors.exceptionOverAmount');
  }

  // Conditional on still being approved: this is what makes "once" true.
  const claimed = await tx.priceException.updateMany({
    where: { id: row.id, status: 'APPROVED' },
    data: { status: 'USED', usedAt: new Date() },
  });
  if (claimed.count === 0) {
    throw refuse('That approval has already been used', 'errors.exceptionAlreadyUsed');
  }

  return { rate: row.approvedRate, boardRate: row.boardRate };
}

/**
 * Stamps the deal onto the approval, and what the concession cost.
 *
 * The cost is worked out here rather than derived later from the transaction,
 * because later cannot see it: on a split only part of the deal was priced by
 * the approval, and the board it is measured against moves. A teller's
 * evaluation must not rest on a figure that changes when a rate is republished.
 */
export async function stamp(
  id: string,
  transactionId: string,
  conceded: { amount: bigint; currency: string },
  tx: DbClient,
): Promise<void> {
  await tx.priceException.update({
    where: { id },
    data: {
      usedByTransactionId: transactionId,
      concededAmount: conceded.amount,
      concededCurrency: conceded.currency,
    },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Moves stale rows out of the queue.
 *
 * Lazily, when somebody looks. A background sweep would be a second thing that
 * decides whether an approval is live, and `claim` already refuses an expired
 * one whatever the column says — this is only so the screens do not show a live
 * badge on something already dead.
 */
export async function sweepExpired(db: DbClient = prisma): Promise<number> {
  const { count } = await db.priceException.updateMany({
    where: { status: 'APPROVED', expiresAt: { lte: new Date() } },
    data: { status: 'EXPIRED' },
  });
  return count;
}

/** Everything a manager still has to answer, oldest first. */
export async function pending(branchId: string | null, db: DbClient = prisma) {
  await sweepExpired(db);
  return db.priceException.findMany({
    where: { status: 'PENDING', ...(branchId ? { branchId } : {}) },
    orderBy: { createdAt: 'asc' },
    include: { requestedBy: { select: { id: true, fullNameEn: true, fullNameAr: true } } },
  });
}

/** What one teller has asked for and what came back. */
export async function mine(userId: string, db: DbClient = prisma) {
  await sweepExpired(db);
  return db.priceException.findMany({
    where: { requestedById: userId, status: { in: ['PENDING', 'APPROVED'] } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
}

/** Recently decided, for the manager to look back over. */
export async function recent(branchId: string | null, limit = 20, db: DbClient = prisma) {
  return db.priceException.findMany({
    where: {
      status: { in: ['APPROVED', 'REJECTED', 'USED', 'EXPIRED', 'CANCELLED'] },
      ...(branchId ? { branchId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    include: {
      requestedBy: { select: { fullNameEn: true, fullNameAr: true } },
      approvedBy: { select: { fullNameEn: true, fullNameAr: true } },
      usedByTransaction: { select: { reference: true } },
    },
  });
}

/**
 * What the board says right now for a pair, so a screen can show the manager
 * the three numbers side by side without pricing an amount it does not have.
 */
export async function boardRateFor(
  fromCurrency: string,
  toCurrency: string,
  channel: RateChannel,
  db: DbClient = prisma,
): Promise<bigint | null> {
  const direct = await getActiveRate(fromCurrency, toCurrency, channel, db);
  if (!direct) return null;
  const priced = await quoteExchange(fromCurrency, toCurrency, ONE, channel, db);
  return priced.rate;
}
