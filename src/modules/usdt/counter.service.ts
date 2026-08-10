import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { nextReference } from '@/modules/sequence/reference';
import { quoteExchange } from '@/modules/exchange/rates.service';
import * as transactions from '@/modules/exchange/transaction.service';
import * as settings from '@/modules/settings/settings.service';
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

  const maximum = await settings.getMoney('usdt.counterMaxAmount', db);
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
  /** More than one transfer fits. The teller chooses; the system will not. */
  | { state: 'AMBIGUOUS'; candidates: { id: string; txHash: string; amount: string; seenAt: Date }[] };

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

  if (candidates.length === 0) return { state: 'WAITING', confirmations: null };

  const required = request.wallet.minConfirmations;
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
  if (transfer.amount !== request.expectedAmount) {
    throw errors.precondition(
      `That transfer is ${toDecimalString(transfer.amount, 2)}, not ${toDecimalString(request.expectedAmount, 2)}`,
      'errors.depositAmountMismatch',
      {
        found: toDecimalString(transfer.amount, 2),
        expected: toDecimalString(request.expectedAmount, 2),
      },
    );
  }

  await claim(id, chainTransactionId, db);

  await audit.record({
    action: 'UPDATE',
    module: 'usdt',
    entityType: 'UsdtDepositRequest',
    entityId: id,
    summaryEn: `Attached transfer ${transfer.txHash} to counter request ${request.reference}`,
    summaryAr: `ربط التحويل ${transfer.txHash} بطلب الاستلام ${request.reference}`,
    actor,
    after: { txHash: transfer.txHash, chainTransactionId },
  });
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

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
  const created = await transactions.record(
    {
      type: 'USDT_RECEIVE',
      branchId: request.branchId,
      customerId: request.customerId,
      fromCurrency: request.wallet.tokenSymbol,
      fromAmount: request.expectedAmount,
      toCurrency: request.payoutCurrency,
      // The price agreed while the customer stood there, not whatever the board
      // has moved to in the minutes since the chain took to confirm.
      toAmount: request.quotedAmount,
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
    summaryEn: `Settled counter request ${request.reference} as ${created.reference}: ${toDecimalString(request.expectedAmount, 2)} ${request.wallet.tokenSymbol} paid out as ${toDecimalString(request.quotedAmount, 2)} ${request.payoutCurrency}`,
    summaryAr: `تسوية طلب الاستلام ${request.reference} بالعملية ${created.reference}: ${toDecimalString(request.expectedAmount, 2)} ${request.wallet.tokenSymbol} مقابل ${toDecimalString(request.quotedAmount, 2)} ${request.payoutCurrency}`,
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
