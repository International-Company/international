import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { convert, toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { nextReference } from '@/modules/sequence/reference';
import { quoteExchange } from '@/modules/exchange/rates.service';
import * as transactions from '@/modules/exchange/transaction.service';
import * as settings from '@/modules/settings/settings.service';
import { ceilingFor } from '@/modules/users/counter-limit';
import * as audit from '@/modules/audit/audit.service';
import { syncWallet } from './sync.service';
import { providerFor } from './providers';

/**
 * The USDT counter.
 *
 * A customer at the window wants to hand over USDT and walk out with cash. The
 * chain will eventually prove that *somebody* sent USDT to our address; it will
 * never prove it was this person. So the request is recorded before the money
 * moves — the amount, the rate quoted, the window it is expected in — and an
 * arriving transfer is matched against that record rather than against a memory.
 *
 * Everything here is built so that no step guesses. When two transfers could
 * satisfy one request, or one transfer could satisfy two requests, the system
 * refuses to choose and says so.
 */

const log = createLogger('usdt:counter');

export const DEPOSIT_STATUSES = ['OPEN', 'MATCHED', 'COMPLETED', 'EXPIRED', 'CANCELLED'] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
  branchId?: string | null;
}

/**
 * USDT is quoted to two decimals at the counter, so the reservation nudges by
 * 0.01 — the smallest step a customer can actually be asked to type. Anything
 * finer would be invisible in their wallet and defeat the whole mechanism.
 */
const RESERVATION_STEP = 1_000_000n; // 0.01 at the 1e8 scale
const MAX_RESERVATION_STEPS = 99;

/**
 * How long after expiry a transfer still counts. Customers press send as the
 * countdown runs out, and blocks take time to confirm; refusing money that was
 * plainly sent in good time would be the system's error, not theirs.
 */
const MATCH_GRACE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Counter addresses
// ---------------------------------------------------------------------------

/**
 * The addresses the manager has released to the counter, in display order.
 *
 * A monitored wallet is not automatically one we hand out: an office watches
 * addresses belonging to partners and to its own cold storage, and printing one
 * of those on a customer-facing screen would invite money we cannot spend.
 */
export async function counterAddresses(db: DbClient = prisma) {
  const wallets = await db.wallet.findMany({
    where: { isCounterAddress: true, isActive: true },
    orderBy: [{ counterSortOrder: 'asc' }, { label: 'asc' }],
    select: {
      id: true,
      label: true,
      labelAr: true,
      network: true,
      address: true,
      tokenSymbol: true,
      minConfirmations: true,
      drawerId: true,
    },
  });

  return wallets.map((wallet) => ({
    ...wallet,
    explorerUrl: providerFor(wallet.network).explorerUrl(''),
    /** Whether the chain can be queried, or staff must confirm by hand. */
    isAutomatic: providerFor(wallet.network).network !== 'MANUAL',
  }));
}

// ---------------------------------------------------------------------------
// Opening a request
// ---------------------------------------------------------------------------

export interface OpenRequestInput {
  walletId: string;
  branchId: string;
  /** What the customer says they will send, before reservation. */
  amount: bigint;
  payoutCurrency: string;
  customerId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  notes?: string | null;
}

/**
 * Reserves an amount no other live request on this address is waiting for.
 *
 * Two customers sending "500" to the same address within the same hour would
 * otherwise be indistinguishable, and the first to be looked at would be paid
 * twice. Nudging the second to 500.01 makes the chain itself carry the
 * distinction, which no amount of care at the counter can otherwise recover.
 */
async function reserveAmount(tx: DbClient, walletId: string, amount: bigint): Promise<bigint> {
  const live = await tx.usdtDepositRequest.findMany({
    where: { walletId, status: { in: ['OPEN', 'MATCHED'] } },
    select: { expectedAmount: true },
  });

  const taken = new Set(live.map((request) => request.expectedAmount.toString()));

  for (let step = 0; step <= MAX_RESERVATION_STEPS; step++) {
    const candidate = amount + BigInt(step) * RESERVATION_STEP;
    if (!taken.has(candidate.toString())) return candidate;
  }

  throw errors.conflict(
    'Too many requests are open on this address for the same amount',
    'errors.depositNoFreeAmount',
  );
}

export async function openRequest(input: OpenRequestInput, actor: Actor, db: DbClient = prisma) {
  if (!(await settings.getBoolean('usdt.counterEnabled', db))) {
    throw errors.precondition('The USDT counter is switched off', 'errors.counterDisabled');
  }
  if (input.amount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const maximum = await ceilingFor(
    actor.id,
    await settings.getMoney('usdt.counterMaxAmount', db),
    db,
  );
  if (maximum > 0n && input.amount > maximum) {
    throw errors.precondition(
      `A counter request cannot exceed ${toDecimalString(maximum, 2)} USDT`,
      'errors.counterAmountTooLarge',
      { maximum: toDecimalString(maximum, 2) },
    );
  }

  const minutes = await settings.getNumber('usdt.counterRequestMinutes', db);

  return withTransaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { id: input.walletId } });
    if (!wallet) throw errors.notFound('Wallet', input.walletId);
    if (!wallet.isCounterAddress || !wallet.isActive) {
      throw errors.precondition(
        'That address is not available at the counter',
        'errors.notACounterAddress',
      );
    }

    if (input.customerId) {
      const customer = await tx.customer.findUnique({ where: { id: input.customerId } });
      if (!customer) throw errors.notFound('Customer', input.customerId);
      if (customer.isBlocked) {
        throw errors.precondition(
          `Customer ${customer.code} is blocked`,
          'errors.customerBlocked',
        );
      }
    }

    const useUnique = await settings.getBoolean('usdt.counterUniqueAmount', tx);
    const expectedAmount = useUnique
      ? await reserveAmount(tx, wallet.id, input.amount)
      : input.amount;

    // Quote on the reserved amount, not the requested one: the customer is
    // asked to send the reserved figure, so that is what they are paid for.
    // The USDT window pays from the till today. When it learns to settle
    // through the broker it will pass that channel instead.
    const quote = await quoteExchange(
      wallet.tokenSymbol,
      input.payoutCurrency,
      expectedAmount,
      'CASH',
      tx,
    );

    const reference = await nextReference('DEP', tx);

    const request = await tx.usdtDepositRequest.create({
      data: {
        reference,
        walletId: wallet.id,
        network: wallet.network,
        address: wallet.address,
        requestedAmount: input.amount,
        expectedAmount,
        payoutCurrency: input.payoutCurrency,
        quotedRate: quote.rate,
        quotedAmount: quote.toAmount,
        customerId: input.customerId ?? null,
        counterpartyName: input.counterpartyName ?? null,
        counterpartyPhone: input.counterpartyPhone ?? null,
        notes: input.notes ?? null,
        branchId: input.branchId,
        status: 'OPEN',
        expiresAt: new Date(Date.now() + minutes * 60_000),
        createdById: actor.id,
      },
    });

    await audit.record(
      {
        action: 'CREATE',
        module: 'usdt',
        entityType: 'UsdtDepositRequest',
        entityId: request.id,
        summaryEn: `Opened counter request ${reference} for ${toDecimalString(expectedAmount, 2)} ${wallet.tokenSymbol} on ${wallet.network}`,
        summaryAr: `فتح طلب استلام ${reference} بمبلغ ${toDecimalString(expectedAmount, 2)} ${wallet.tokenSymbol} على شبكة ${wallet.network}`,
        actor,
        after: {
          reference,
          expectedAmount: expectedAmount.toString(),
          payoutCurrency: input.payoutCurrency,
          quotedAmount: quote.toAmount.toString(),
        },
      },
      tx,
    );

    return request;
  }, db);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export type MatchOutcome =
  | { state: 'WAITING'; confirmations: null }
  /** Seen on chain but not yet final — the teller must not pay out. */
  | { state: 'UNCONFIRMED'; confirmations: number; required: number; txHash: string }
  | { state: 'MATCHED'; chainTransactionId: string; txHash: string; confirmations: number }
  /**
   * A transfer that is plainly this customer's, for a different figure.
   *
   * Offered only when it cannot be anybody else's — see `soleClaimant`. The
   * teller decides; the system will not settle a different amount by itself.
   */
  | {
      state: 'NEAR';
      chainTransactionId: string;
      txHash: string;
      confirmations: number;
      arrived: string;
      expected: string;
      /** Arrived minus expected: negative is short, positive is over. */
      difference: string;
    }
  /** More than one transfer fits. The teller chooses; the system will not. */
  | { state: 'AMBIGUOUS'; candidates: { id: string; txHash: string; amount: string; seenAt: Date }[] };

/**
 * Whether this request is the only thing an unexpected amount could belong to.
 *
 * The reserved amount exists to tell two customers apart. The moment a transfer
 * for some *other* figure is allowed to settle a request, that protection is
 * gone — so it is allowed only where there was nothing to protect against: one
 * live request on this address, and one unclaimed arrival that could serve it.
 *
 * With a second request open the answer is no, however obvious the pairing
 * looks to the person at the counter. Cancel one and the question answers
 * itself; guess, and one day the wrong customer is paid.
 */
async function soleClaimant(
  requestId: string,
  walletId: string,
  db: DbClient,
): Promise<boolean> {
  const others = await db.usdtDepositRequest.count({
    where: { walletId, status: { in: ['OPEN', 'MATCHED'] }, id: { not: requestId } },
  });
  return others === 0;
}

/**
 * Looks for the transfer that satisfies a request.
 *
 * Deliberately narrow: the right amount, to the right address, inside the
 * window, not already spoken for. A transfer that is merely close is not a
 * match — at a counter, "close enough" is how the wrong person gets paid.
 */
export async function checkRequest(
  id: string,
  options: { sync?: boolean } = {},
  db: DbClient = prisma,
): Promise<MatchOutcome> {
  const request = await db.usdtDepositRequest.findUnique({
    where: { id },
    include: { wallet: true },
  });
  if (!request) throw errors.notFound('Deposit request', id);

  if (request.status === 'COMPLETED' || request.status === 'CANCELLED') {
    throw errors.conflict('This request is already settled', 'errors.depositSettled');
  }

  // Poll the chain first, so a customer who just pressed send is not told to
  // wait for the next scheduled sync.
  if (options.sync !== false && providerFor(request.wallet.network).network !== 'MANUAL') {
    await syncWallet(request.walletId, {}, db).catch((error) => {
      log.warn('Counter sync failed; falling back to stored transfers', {
        requestId: id,
        error,
      });
    });
  }

  const windowStart = new Date(request.createdAt.getTime() - 5 * 60_000);
  const windowEnd = new Date(request.expiresAt.getTime() + MATCH_GRACE_MS);

  const candidates = await db.chainTransaction.findMany({
    where: {
      walletId: request.walletId,
      direction: 'IN',
      amount: request.expectedAmount,
      firstSeenAt: { gte: windowStart, lte: windowEnd },
      // Never take a transfer another request already owns, or one already
      // posted to the ledger by some other route.
      depositRequest: { is: null },
      linkedTransactionId: null,
    },
    orderBy: { firstSeenAt: 'asc' },
    select: {
      id: true,
      txHash: true,
      amount: true,
      status: true,
      confirmations: true,
      firstSeenAt: true,
    },
  });

  const required = request.wallet.minConfirmations;

  /*
   * Nothing for the figure asked for. Before reporting a blank wait, look for
   * the ordinary human outcome: they sent a different number.
   *
   * A customer told to send 500.01 sends 500, or rounds off the network fee, or
   * types what they meant to send in the first place. Today that is not a match
   * and the teller cancels a request the customer has already paid into. It is
   * the most common way this screen fails, and the money is sitting right there
   * on the address while it happens.
   */
  if (candidates.length === 0) {
    const near = await nearArrival(request.id, request.walletId, windowStart, windowEnd, required, db);
    if (near) {
      return {
        state: 'NEAR',
        chainTransactionId: near.id,
        txHash: near.txHash,
        confirmations: near.confirmations,
        arrived: near.amount.toString(),
        expected: request.expectedAmount.toString(),
        difference: (near.amount - request.expectedAmount).toString(),
      };
    }
    return { state: 'WAITING', confirmations: null };
  }
  const confirmed = candidates.filter(
    (candidate) => candidate.status === 'CONFIRMED' && candidate.confirmations >= required,
  );

  if (confirmed.length > 1) {
    return {
      state: 'AMBIGUOUS',
      candidates: confirmed.map((candidate) => ({
        id: candidate.id,
        txHash: candidate.txHash,
        amount: candidate.amount.toString(),
        seenAt: candidate.firstSeenAt,
      })),
    };
  }

  if (confirmed.length === 1) {
    const match = confirmed[0]!;
    await claim(id, match.id, db);
    return {
      state: 'MATCHED',
      chainTransactionId: match.id,
      txHash: match.txHash,
      confirmations: match.confirmations,
    };
  }

  // Seen, but not yet final. Show the progress rather than a blank wait.
  const pending = candidates[0]!;
  return {
    state: 'UNCONFIRMED',
    confirmations: pending.confirmations,
    required,
    txHash: pending.txHash,
  };
}

/**
 * The one unclaimed arrival on this address that could only be this request's.
 *
 * Confirmed, in the window, unspoken for, and alone — both in the sense that no
 * other transfer is sitting there unclaimed and that no other request is open
 * to claim it. Anything less than alone and this returns nothing: a near miss
 * is a convenience, and a convenience is never worth paying the wrong person.
 */
async function nearArrival(
  requestId: string,
  walletId: string,
  windowStart: Date,
  windowEnd: Date,
  required: number,
  db: DbClient,
) {
  if (!(await soleClaimant(requestId, walletId, db))) return null;

  const loose = await db.chainTransaction.findMany({
    where: {
      walletId,
      direction: 'IN',
      firstSeenAt: { gte: windowStart, lte: windowEnd },
      depositRequest: { is: null },
      linkedTransactionId: null,
      status: 'CONFIRMED',
      confirmations: { gte: required },
    },
    orderBy: { firstSeenAt: 'asc' },
    take: 2,
    select: { id: true, txHash: true, amount: true, confirmations: true },
  });

  return loose.length === 1 ? loose[0]! : null;
}

/** Binds a transfer to a request, refusing if either has been taken meanwhile. */
async function claim(requestId: string, chainTransactionId: string, db: DbClient): Promise<void> {
  const bound = await db.usdtDepositRequest.updateMany({
    where: { id: requestId, status: 'OPEN' },
    data: { status: 'MATCHED', matchedChainTransactionId: chainTransactionId, matchedAt: new Date() },
  });

  if (bound.count === 0) {
    const current = await db.usdtDepositRequest.findUnique({
      where: { id: requestId },
      select: { status: true, matchedChainTransactionId: true },
    });
    // Already pointing at this transfer is not a conflict, it is the same news
    // arriving twice — two tellers refreshing the same screen.
    if (current?.matchedChainTransactionId === chainTransactionId) return;
    throw errors.conflict('This request is no longer open', 'errors.depositNotOpen');
  }
}

/**
 * Attaches a transfer the teller identified themselves — by pasting the hash
 * from the customer's wallet, or by choosing between ambiguous candidates.
 */
export async function attachTransfer(
  id: string,
  chainTransactionId: string,
  actor: Actor,
  /**
   * Settle the figure that arrived rather than the figure that was asked for.
   *
   * An explicit decision and never a tolerance: there is no amount of drift
   * this system quietly forgives on its own. The teller is looking at the
   * customer, at the difference, and at both numbers, and says yes.
   */
  options: { acceptDifference?: boolean } = {},
  db: DbClient = prisma,
): Promise<void> {
  const [request, transfer] = await Promise.all([
    db.usdtDepositRequest.findUnique({ where: { id }, include: { wallet: true } }),
    db.chainTransaction.findUnique({
      where: { id: chainTransactionId },
      include: { depositRequest: { select: { reference: true } } },
    }),
  ]);

  if (!request) throw errors.notFound('Deposit request', id);
  if (!transfer) throw errors.notFound('Chain transaction', chainTransactionId);

  if (transfer.walletId !== request.walletId) {
    throw errors.precondition(
      'That transfer went to a different address',
      'errors.depositWrongAddress',
    );
  }
  if (transfer.direction !== 'IN') {
    throw errors.precondition('That is an outgoing transfer', 'errors.depositNotIncoming');
  }
  if (transfer.depositRequest) {
    throw errors.conflict(
      `That transfer already settles ${transfer.depositRequest.reference}`,
      'errors.depositAlreadyClaimed',
    );
  }
  if (transfer.linkedTransactionId) {
    throw errors.conflict('That transfer is already posted', 'errors.depositAlreadyPosted');
  }
  if (transfer.status !== 'CONFIRMED' || transfer.confirmations < request.wallet.minConfirmations) {
    throw errors.precondition(
      'That transfer is not confirmed yet',
      'errors.transferNotConfirmed',
    );
  }
  const differs = transfer.amount !== request.expectedAmount;

  if (differs && !options.acceptDifference) {
    throw errors.precondition(
      `That transfer is ${toDecimalString(transfer.amount, 2)}, not ${toDecimalString(request.expectedAmount, 2)}`,
      'errors.depositAmountMismatch',
      {
        found: toDecimalString(transfer.amount, 2),
        expected: toDecimalString(request.expectedAmount, 2),
      },
    );
  }

  // Saying yes to a different figure is only ever offered where nothing else
  // could have sent it. Checked here and not only where the offer was made:
  // a second request can be opened between the teller reading the screen and
  // pressing the button.
  if (differs && !(await soleClaimant(id, request.walletId, db))) {
    throw errors.conflict(
      'Another request is open on this address — the amount is what tells them apart',
      'errors.depositNotSole',
    );
  }

  await claim(id, chainTransactionId, db);

  await audit.record({
    action: 'UPDATE',
    module: 'usdt',
    entityType: 'UsdtDepositRequest',
    entityId: id,
    summaryEn: differs
      ? `Attached transfer ${transfer.txHash} to counter request ${request.reference} at ${toDecimalString(transfer.amount, 2)} instead of ${toDecimalString(request.expectedAmount, 2)}`
      : `Attached transfer ${transfer.txHash} to counter request ${request.reference}`,
    summaryAr: differs
      ? `ربط التحويل ${transfer.txHash} بطلب الاستلام ${request.reference} على ${toDecimalString(transfer.amount, 2)} بدل ${toDecimalString(request.expectedAmount, 2)}`
      : `ربط التحويل ${transfer.txHash} بطلب الاستلام ${request.reference}`,
    actor,
    after: {
      txHash: transfer.txHash,
      chainTransactionId,
      arrived: transfer.amount.toString(),
      expected: request.expectedAmount.toString(),
    },
  });
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/** A currency's precision, for pricing an amount nobody quoted in advance. */
async function decimalsOf(code: string, db: DbClient): Promise<number> {
  const currency = await db.currency.findUnique({
    where: { code },
    select: { decimals: true },
  });
  if (!currency) throw errors.notFound('Currency', code);
  return currency.decimals;
}

/**
 * Settles a matched request as one transaction: the USDT arrives in the wallet's
 * ledger account and the cash leaves the drawer, priced at the rate the customer
 * was quoted when they were standing there.
 *
 * One movement rather than two, because that is what happened. Splitting it into
 * a receipt and a separate exchange would leave a customer balance that exists
 * for no reason and can be left dangling if the teller is interrupted.
 */
export async function completeRequest(id: string, actor: Actor, db: DbClient = prisma) {
  const request = await db.usdtDepositRequest.findUnique({
    where: { id },
    include: { wallet: true, matchedChainTransaction: true },
  });
  if (!request) throw errors.notFound('Deposit request', id);

  if (request.status === 'COMPLETED') {
    throw errors.conflict('This request is already settled', 'errors.depositSettled');
  }
  if (request.status !== 'MATCHED') {
    throw errors.conflict(
      'No confirmed transfer is attached to this request',
      'errors.depositNotMatched',
    );
  }
  if (!request.matchedChainTransaction) {
    throw errors.conflict('The attached transfer is missing', 'errors.depositNotMatched');
  }
  /*
   * The quantity is what arrived; the price is what was promised.
   *
   * Those are two different questions and they have two different sources. A
   * customer asked for 500.01 who sent 500 is paid for 500 — posting the figure
   * that was *asked for* would put coins in the ledger that nobody sent — but
   * paid at the rate quoted while they stood there, which is the half of the
   * bargain the office owes regardless of what the board did since.
   *
   * When the two amounts agree, which is almost always, this is the quoted
   * payout to the last unit: the same multiplication that produced it.
   */
  const arrived = request.matchedChainTransaction.amount;
  const payout =
    arrived === request.expectedAmount
      ? request.quotedAmount
      : convert(arrived, request.quotedRate, await decimalsOf(request.payoutCurrency, db));

  const created = await transactions.record(
    {
      type: 'USDT_RECEIVE',
      branchId: request.branchId,
      customerId: request.customerId,
      fromCurrency: request.wallet.tokenSymbol,
      fromAmount: arrived,
      toCurrency: request.payoutCurrency,
      toAmount: payout,
      rate: request.quotedRate,
      counterpartyName: request.counterpartyName,
      counterpartyPhone: request.counterpartyPhone,
      notes: request.notes,
    },
    actor,
    db,
  );

  // The posting already committed. These two links must land together or the
  // request would look unsettled while its money sits in the ledger.
  await withTransaction(async (tx) => {
    await tx.usdtDepositRequest.update({
      where: { id },
      data: { status: 'COMPLETED', transactionId: created.id, completedAt: new Date() },
    });
    await tx.chainTransaction.update({
      where: { id: request.matchedChainTransaction!.id },
      data: { linkedTransactionId: created.id, isReconciled: true, processedAt: new Date() },
    });
  }, db);

  await audit.record({
    action: 'POST',
    module: 'usdt',
    entityType: 'UsdtDepositRequest',
    entityId: id,
    summaryEn: `Settled counter request ${request.reference} as ${created.reference}: ${toDecimalString(arrived, 2)} ${request.wallet.tokenSymbol} paid out as ${toDecimalString(payout, 2)} ${request.payoutCurrency}`,
    summaryAr: `تسوية طلب الاستلام ${request.reference} بالعملية ${created.reference}: ${toDecimalString(arrived, 2)} ${request.wallet.tokenSymbol} مقابل ${toDecimalString(payout, 2)} ${request.payoutCurrency}`,
    actor,
    after: { transactionReference: created.reference, transactionId: created.id },
  });

  log.info('Counter request settled', {
    reference: request.reference,
    transaction: created.reference,
  });

  return created;
}

export async function cancelRequest(
  id: string,
  reason: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  if (!reason.trim()) {
    throw errors.validation([{ path: 'reason', message: 'A reason is required' }]);
  }

  const request = await db.usdtDepositRequest.findUnique({ where: { id } });
  if (!request) throw errors.notFound('Deposit request', id);

  if (request.status === 'COMPLETED') {
    throw errors.conflict(
      'A settled request cannot be cancelled — reverse the transaction instead',
      'errors.depositSettled',
    );
  }

  const cancelled = await db.usdtDepositRequest.updateMany({
    where: { id, status: { in: ['OPEN', 'MATCHED', 'EXPIRED'] } },
    data: { status: 'CANCELLED', cancelReason: reason },
  });
  if (cancelled.count === 0) {
    throw errors.conflict('This request can no longer be cancelled', 'errors.depositSettled');
  }

  await audit.record({
    action: 'CANCEL',
    module: 'usdt',
    entityType: 'UsdtDepositRequest',
    entityId: id,
    summaryEn: `Cancelled counter request ${request.reference}: ${reason}`,
    summaryAr: `إلغاء طلب الاستلام ${request.reference}: ${reason}`,
    actor,
  });
}

/**
 * Expires requests nobody paid.
 *
 * Only OPEN ones: a MATCHED request has money on the chain behind it, and
 * quietly expiring that would strand a real transfer with no record of who it
 * belonged to.
 */
export async function expireStaleRequests(db: DbClient = prisma): Promise<number> {
  const { count } = await db.usdtDepositRequest.updateMany({
    where: { status: 'OPEN', expiresAt: { lt: new Date() } },
    data: { status: 'EXPIRED' },
  });

  if (count > 0) log.info('Expired counter requests', { count });
  return count;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface RequestFilter {
  status?: DepositStatus | DepositStatus[];
  walletId?: string;
  createdById?: string;
  page?: number;
  pageSize?: number;
}

export async function listRequests(
  filter: RequestFilter,
  actor: Actor,
  db: DbClient = prisma,
) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));

  const where = {
    ...(filter.status
      ? { status: Array.isArray(filter.status) ? { in: filter.status } : filter.status }
      : {}),
    ...(filter.walletId ? { walletId: filter.walletId } : {}),
    // Without `viewAll` a teller sees only the requests they opened, matching
    // how transactions already behave.
    ...(actor.permissions.includes('exchange.transaction.viewAll')
      ? filter.createdById
        ? { createdById: filter.createdById }
        : {}
      : { createdById: actor.id }),
  };

  const [rows, total] = await Promise.all([
    db.usdtDepositRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        wallet: { select: { label: true, labelAr: true, network: true } },
        customer: { select: { id: true, code: true, fullNameEn: true, fullNameAr: true } },
        createdBy: { select: { fullNameEn: true, fullNameAr: true } },
        transaction: { select: { id: true, reference: true } },
        matchedChainTransaction: { select: { txHash: true, confirmations: true } },
      },
    }),
    db.usdtDepositRequest.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}

export async function getRequest(id: string, actor: Actor, db: DbClient = prisma) {
  const request = await db.usdtDepositRequest.findUnique({
    where: { id },
    include: {
      wallet: true,
      customer: { select: { id: true, code: true, fullNameEn: true, fullNameAr: true } },
      createdBy: { select: { fullNameEn: true, fullNameAr: true } },
      transaction: { select: { id: true, reference: true } },
      matchedChainTransaction: true,
    },
  });
  if (!request) throw errors.notFound('Deposit request', id);

  if (
    !actor.permissions.includes('exchange.transaction.viewAll') &&
    request.createdById !== actor.id
  ) {
    throw errors.forbidden('exchange.transaction.viewAll');
  }

  return request;
}

// ---------------------------------------------------------------------------
// Money that arrived before anyone asked it to
// ---------------------------------------------------------------------------

/**
 * The tray: every transfer sitting on a counter address that nobody has claimed.
 *
 * ## Why this exists
 *
 * The request flow above assumes an order of events — the teller opens a
 * request, *then* the customer sends. Plenty of customers do it the other way.
 * They send from the taxi, they send before they walk in, they send while the
 * teller is still finding the address. Under a request-first design every one
 * of those is a failure: no request exists, so nothing matches, and the money
 * lands on the address and is seen by nobody at all.
 *
 * That last part is the serious half. An unclaimed arrival had no screen. It
 * was in the wallet, in `chain_transactions`, real and spendable — and invisible
 * until somebody thought to reconcile. A counter that cannot see money arriving
 * at its own door is not watching the door.
 *
 * ## What it changes about the work
 *
 * Nothing needs to be opened, reserved, nudged or timed. The money is already
 * here; what is missing is only who it belongs to and what they are owed. So the
 * teller names the customer and the currency and settles, priced at the board
 * *now* — because there is no promise from earlier to honour. The office carries
 * no rate risk on this path at all, which the request path cannot say.
 *
 * The request flow is not replaced. It is still the right tool when a customer
 * is about to send and wants a figure held. This is the right tool when they
 * already have.
 */
export interface Arrival {
  id: string;
  txHash: string;
  amount: bigint;
  confirmations: number;
  required: number;
  /** Whether it may be paid out, or is still settling on the chain. */
  ready: boolean;
  firstSeenAt: Date;
  fromAddress: string | null;
  wallet: { id: string; label: string; labelAr: string; network: string; tokenSymbol: string };
}

/**
 * What is waiting, newest first.
 *
 * Only counter addresses. The office watches wallets it does not hand out —
 * cold storage, a partner's — and offering to pay a customer for a movement on
 * one of those would be inviting a teller to give away the office's own money.
 */
export async function unclaimedArrivals(
  options: { sync?: boolean; limit?: number } = {},
  db: DbClient = prisma,
): Promise<Arrival[]> {
  const wallets = await db.wallet.findMany({
    where: { isCounterAddress: true, isActive: true },
    select: { id: true, network: true },
  });

  /*
   * Asked of the chain before it is read from the table, so a teller who opens
   * the tray because the customer says "I sent it" sees it appear rather than
   * being told to wait for a scheduled sync. A provider having a bad minute
   * must not empty the tray, so a failure falls through to what is stored.
   */
  if (options.sync !== false) {
    await Promise.all(
      wallets
        .filter((wallet) => providerFor(wallet.network).network !== 'MANUAL')
        .map((wallet) =>
          syncWallet(wallet.id, {}, db).catch((error) =>
            log.warn('Arrivals sync failed; showing what is already stored', {
              walletId: wallet.id,
              error,
            }),
          ),
        ),
    );
  }

  /*
   * An address with a live request on it belongs to that request.
   *
   * Both doors would otherwise open onto the same transfer: the request panel
   * offering to settle it at the rate the customer was quoted, and the tray
   * offering to settle it at today's board. Whichever the teller pressed first
   * would win, the customer would be paid one of two different figures
   * depending on where the teller happened to look, and the losing screen would
   * be left pointing at money that was already spent.
   *
   * So while a request is waiting on an address, that address is its business.
   * The tray is for money nobody is waiting for — which is the case it was
   * built for, and the only one where it is unambiguously right.
   */
  const spokenFor = await db.usdtDepositRequest.findMany({
    where: { status: { in: ['OPEN', 'MATCHED'] } },
    select: { walletId: true },
    distinct: ['walletId'],
  });
  const busy = new Set(spokenFor.map((request) => request.walletId));
  const free = wallets.filter((wallet) => !busy.has(wallet.id));

  const rows = await db.chainTransaction.findMany({
    where: {
      walletId: { in: free.map((wallet) => wallet.id) },
      direction: 'IN',
      depositRequest: { is: null },
      linkedTransactionId: null,
    },
    orderBy: { firstSeenAt: 'desc' },
    take: options.limit ?? 20,
    select: {
      id: true,
      txHash: true,
      amount: true,
      status: true,
      confirmations: true,
      firstSeenAt: true,
      fromAddress: true,
      wallet: {
        select: {
          id: true,
          label: true,
          labelAr: true,
          network: true,
          tokenSymbol: true,
          minConfirmations: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    txHash: row.txHash,
    amount: row.amount,
    confirmations: row.confirmations,
    required: row.wallet.minConfirmations,
    ready: row.status === 'CONFIRMED' && row.confirmations >= row.wallet.minConfirmations,
    firstSeenAt: row.firstSeenAt,
    fromAddress: row.fromAddress,
    wallet: {
      id: row.wallet.id,
      label: row.wallet.label,
      labelAr: row.wallet.labelAr,
      network: row.wallet.network,
      tokenSymbol: row.wallet.tokenSymbol,
    },
  }));
}

/**
 * What an arrival would pay, before anybody commits to it.
 *
 * Priced here rather than through the general quote endpoint because a teller
 * does not hold `exchange.rate.view` — deliberately, so the sidebar stays their
 * own tools. The counter has always priced inside `usdt.counter.use`, on the
 * server, and this is the same arrangement: the teller learns the figure they
 * are about to read aloud without being handed the board.
 */
export async function quoteArrival(
  chainTransactionId: string,
  payoutCurrency: string,
  db: DbClient = prisma,
): Promise<{ amount: string; toAmount: string; rate: string; payoutCurrency: string }> {
  const transfer = await db.chainTransaction.findUnique({
    where: { id: chainTransactionId },
    select: { amount: true, direction: true, wallet: { select: { tokenSymbol: true, isCounterAddress: true } } },
  });

  if (!transfer) throw errors.notFound('Chain transaction', chainTransactionId);
  if (!transfer.wallet.isCounterAddress) {
    throw errors.precondition(
      'That address is not available at the counter',
      'errors.notACounterAddress',
    );
  }
  if (transfer.direction !== 'IN') {
    throw errors.precondition('That is an outgoing transfer', 'errors.depositNotIncoming');
  }

  const quote = await quoteExchange(
    transfer.wallet.tokenSymbol,
    payoutCurrency.toUpperCase(),
    transfer.amount,
    'CASH',
    db,
  );

  return {
    amount: transfer.amount.toString(),
    toAmount: quote.toAmount.toString(),
    rate: quote.rate.toString(),
    payoutCurrency: payoutCurrency.toUpperCase(),
  };
}

export interface SettleArrivalInput {
  branchId: string;
  payoutCurrency: string;
  customerId?: string | null;
  counterpartyName?: string | null;
  counterpartyPhone?: string | null;
  notes?: string | null;
}

/**
 * Pays a customer for money that is already on the address.
 *
 * Priced now, because nothing was promised earlier. That is the whole
 * difference from `completeRequest`, and it happens to fall in the office's
 * favour rather than the customer's — which is the honest trade for a customer
 * who chose to send before agreeing a price.
 */
export async function settleArrival(
  chainTransactionId: string,
  input: SettleArrivalInput,
  actor: Actor,
  db: DbClient = prisma,
) {
  if (!(await settings.getBoolean('usdt.counterEnabled', db))) {
    throw errors.precondition('The USDT counter is switched off', 'errors.counterDisabled');
  }

  const transfer = await db.chainTransaction.findUnique({
    where: { id: chainTransactionId },
    include: {
      wallet: true,
      depositRequest: { select: { reference: true } },
    },
  });

  if (!transfer) throw errors.notFound('Chain transaction', chainTransactionId);
  if (!transfer.wallet.isCounterAddress || !transfer.wallet.isActive) {
    throw errors.precondition(
      'That address is not available at the counter',
      'errors.notACounterAddress',
    );
  }
  if (transfer.direction !== 'IN') {
    throw errors.precondition('That is an outgoing transfer', 'errors.depositNotIncoming');
  }
  if (transfer.depositRequest) {
    throw errors.conflict(
      `That transfer already settles ${transfer.depositRequest.reference}`,
      'errors.depositAlreadyClaimed',
    );
  }
  if (transfer.linkedTransactionId) {
    throw errors.conflict('That transfer is already posted', 'errors.depositAlreadyPosted');
  }
  if (
    transfer.status !== 'CONFIRMED' ||
    transfer.confirmations < transfer.wallet.minConfirmations
  ) {
    throw errors.precondition('That transfer is not confirmed yet', 'errors.transferNotConfirmed');
  }

  // The same ceiling the request path enforces. A teller's limit is a limit on
  // the teller, not on one of the two doors into the same work.
  const maximum = await ceilingFor(
    actor.id,
    await settings.getMoney('usdt.counterMaxAmount', db),
    db,
  );
  if (maximum > 0n && transfer.amount > maximum) {
    throw errors.precondition(
      `A counter request cannot exceed ${toDecimalString(maximum, 2)} USDT`,
      'errors.counterAmountTooLarge',
      { maximum: toDecimalString(maximum, 2) },
    );
  }

  if (input.customerId) {
    const customer = await db.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw errors.notFound('Customer', input.customerId);
    if (customer.isBlocked) {
      throw errors.precondition(`Customer ${customer.code} is blocked`, 'errors.customerBlocked');
    }
  }

  const quote = await quoteExchange(
    transfer.wallet.tokenSymbol,
    input.payoutCurrency,
    transfer.amount,
    'CASH',
    db,
  );

  const created = await transactions.record(
    {
      type: 'USDT_RECEIVE',
      branchId: input.branchId,
      customerId: input.customerId ?? null,
      fromCurrency: transfer.wallet.tokenSymbol,
      fromAmount: transfer.amount,
      toCurrency: input.payoutCurrency,
      toAmount: quote.toAmount,
      rate: quote.rate,
      rateId: quote.rateId,
      profitAmount: quote.profit,
      counterpartyName: input.counterpartyName ?? null,
      counterpartyPhone: input.counterpartyPhone ?? null,
      notes: input.notes ?? null,
    },
    actor,
    db,
  );

  // Claimed only after the posting exists. The other order would mark the money
  // spoken for and then leave it stranded if the posting failed.
  await db.chainTransaction.update({
    where: { id: chainTransactionId },
    data: { linkedTransactionId: created.id, isReconciled: true, processedAt: new Date() },
  });

  await audit.record({
    action: 'POST',
    module: 'usdt',
    entityType: 'ChainTransaction',
    entityId: chainTransactionId,
    summaryEn: `Settled arrival ${transfer.txHash} as ${created.reference}: ${toDecimalString(transfer.amount, 2)} ${transfer.wallet.tokenSymbol} paid out as ${toDecimalString(quote.toAmount, 2)} ${input.payoutCurrency}`,
    summaryAr: `صرف تحويل واصل ${transfer.txHash} بالعملية ${created.reference}: ${toDecimalString(transfer.amount, 2)} ${transfer.wallet.tokenSymbol} مقابل ${toDecimalString(quote.toAmount, 2)} ${input.payoutCurrency}`,
    actor,
    after: { transactionReference: created.reference, transactionId: created.id },
  });

  log.info('Arrival settled', { txHash: transfer.txHash, transaction: created.reference });

  return created;
}

/**
 * Looking for the money the customer says they sent.
 *
 * ## Why this replaced opening a request first
 *
 * The request flow asked the office to declare a transfer before it existed —
 * pick an address, name a figure, reserve it, start a clock — and only then
 * turn the screen round. Customers do not wait for that. They scan the code and
 * send, often before the teller has finished typing, and everything declared in
 * advance then has to be reconciled against what actually happened.
 *
 * So the order is inverted to the one the counter already works in: the address
 * is on the screen from the moment it is chosen, the customer sends, and the
 * teller types **what arrived** and asks the chain to confirm it. Nothing is
 * promised in advance because nothing needs to be. There is no clock to run
 * out, no reserved figure for the customer to mistype, and no request left open
 * when somebody walks away.
 *
 * ## What is given up, and what replaces it
 *
 * The reserved amount used to tell two customers sending the same figure apart.
 * Without a request there is nothing to reserve — so the same question is asked
 * later instead, at the moment it actually matters: if two unclaimed transfers
 * for that figure are sitting on the address, this refuses to choose and hands
 * the teller both, with the sender, the time and the hash. That is the same
 * discipline the rest of this module keeps. It is not the same protection, and
 * it is worth knowing which one you have.
 */
export type ArrivalSearch =
  /** Nothing for that figure. Either it has not landed or it never will. */
  | { state: 'NONE' }
  /** On the chain, not yet final. Real, but not yet payable. */
  | { state: 'UNCONFIRMED'; confirmations: number; required: number; txHash: string }
  | {
      state: 'FOUND';
      arrival: {
        id: string;
        txHash: string;
        amount: string;
        confirmations: number;
        firstSeenAt: Date;
        fromAddress: string | null;
      };
      /** What the customer is owed, at the board right now. */
      quote: { toAmount: string; rate: string; payoutCurrency: string };
    }
  /** Two transfers for the same figure. The teller chooses; this will not. */
  | {
      state: 'AMBIGUOUS';
      candidates: {
        id: string;
        txHash: string;
        amount: string;
        firstSeenAt: Date;
        fromAddress: string | null;
      }[];
    };

/**
 * Asks the chain, then the table, for an unclaimed transfer of exactly `amount`.
 *
 * Exactly. A figure that is merely close is a different customer until somebody
 * proves otherwise — the teller can retype what the customer actually shows
 * them, which takes a second and is the only honest way to resolve it.
 */
export async function findArrival(
  input: { walletId: string; amount: bigint; payoutCurrency: string },
  db: DbClient = prisma,
): Promise<ArrivalSearch> {
  if (!(await settings.getBoolean('usdt.counterEnabled', db))) {
    throw errors.precondition('The USDT counter is switched off', 'errors.counterDisabled');
  }
  if (input.amount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const wallet = await db.wallet.findUnique({ where: { id: input.walletId } });
  if (!wallet) throw errors.notFound('Wallet', input.walletId);
  if (!wallet.isCounterAddress || !wallet.isActive) {
    throw errors.precondition(
      'That address is not available at the counter',
      'errors.notACounterAddress',
    );
  }

  // Asked of the chain first, because the teller is pressing this button with a
  // customer in front of them saying they have already sent it.
  if (providerFor(wallet.network).network !== 'MANUAL') {
    await syncWallet(wallet.id, {}, db).catch((error) =>
      log.warn('Verify sync failed; falling back to stored transfers', {
        walletId: wallet.id,
        error,
      }),
    );
  }

  const candidates = await db.chainTransaction.findMany({
    where: {
      walletId: wallet.id,
      direction: 'IN',
      amount: input.amount,
      depositRequest: { is: null },
      linkedTransactionId: null,
    },
    orderBy: { firstSeenAt: 'desc' },
    take: 5,
    select: {
      id: true,
      txHash: true,
      amount: true,
      status: true,
      confirmations: true,
      firstSeenAt: true,
      fromAddress: true,
    },
  });

  if (candidates.length === 0) return { state: 'NONE' };

  const required = wallet.minConfirmations;
  const ready = candidates.filter(
    (candidate) => candidate.status === 'CONFIRMED' && candidate.confirmations >= required,
  );

  if (ready.length > 1) {
    return {
      state: 'AMBIGUOUS',
      candidates: ready.map((candidate) => ({
        id: candidate.id,
        txHash: candidate.txHash,
        amount: candidate.amount.toString(),
        firstSeenAt: candidate.firstSeenAt,
        fromAddress: candidate.fromAddress,
      })),
    };
  }

  if (ready.length === 0) {
    const pending = candidates[0]!;
    return {
      state: 'UNCONFIRMED',
      confirmations: pending.confirmations,
      required,
      txHash: pending.txHash,
    };
  }

  const match = ready[0]!;
  const quote = await quoteExchange(
    wallet.tokenSymbol,
    input.payoutCurrency.toUpperCase(),
    match.amount,
    'CASH',
    db,
  );

  return {
    state: 'FOUND',
    arrival: {
      id: match.id,
      txHash: match.txHash,
      amount: match.amount.toString(),
      confirmations: match.confirmations,
      firstSeenAt: match.firstSeenAt,
      fromAddress: match.fromAddress,
    },
    quote: {
      toAmount: quote.toAmount.toString(),
      rate: quote.rate.toString(),
      payoutCurrency: input.payoutCurrency.toUpperCase(),
    },
  };
}
