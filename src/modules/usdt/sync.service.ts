import 'server-only';
import { prisma, withTransaction, type DbClient, type Tx } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';
import * as notifications from '@/modules/notifications/notifications.service';
import { nextReference } from '@/modules/sequence/reference';
import * as settings from '@/modules/settings/settings.service';
import { providerForWallet, type ChainTransfer } from './providers';
import { maskAddress } from './wallet.service';
import { containsInsensitive } from '@/core/db/search';

/**
 * Wallet synchronisation and the bridge into the exchange module.
 *
 * When a confirmed transfer is detected the system does not simply log it: it
 * creates a real internal transaction in DRAFT, links the two records, and
 * notifies whoever can act on it. The draft is never posted automatically —
 * the chain proves money moved, not whose it is, and posting a receipt to the
 * wrong customer costs far more to unwind than a moment's confirmation.
 */

const log = createLogger('usdt:sync');

export interface SyncResult {
  walletId: string;
  fetched: number;
  created: number;
  updated: number;
  balance: bigint | null;
  status: 'OK' | 'ERROR';
  error?: string;
}

export async function syncWallet(
  walletId: string,
  options: {
    actorId?: string;
    deep?: boolean;
    /** Transfers only — for the counter's log, which waits on every request. */
    skipBalance?: boolean;
  } = {},
  db: DbClient = prisma,
): Promise<SyncResult> {
  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw errors.notFound('Wallet', walletId);

  if (!wallet.isActive) {
    return { walletId, fetched: 0, created: 0, updated: 0, balance: null, status: 'OK' };
  }

  const provider = await providerForWallet(wallet, db);

  const run = await db.walletSyncRun.create({
    data: { walletId, provider: provider.name, status: 'RUNNING' },
  });

  let fetched = 0;
  let created = 0;
  let updated = 0;
  let balance: bigint | null = null;

  try {
    // --- Balance ----------------------------------------------------------
    // Manual wallets report 0 by design; never overwrite an operator-set value.
    if (provider.network !== 'MANUAL' && !options.skipBalance) {
      balance = await provider.fetchBalance(wallet.address, wallet.contractAddress);

      if (balance !== wallet.balance) {
        await db.wallet.update({
          where: { id: walletId },
          data: { balance, balanceUpdatedAt: new Date() },
        });
        await db.walletSnapshot.create({ data: { walletId, balance } });
      }
    }

    // --- Transfers ---------------------------------------------------------
    const page = await provider.fetchTransfers(wallet.address, wallet.contractAddress, {
      cursor: options.deep ? null : wallet.syncCursor,
      limit: options.deep ? 200 : 50,
    });

    fetched = page.transfers.length;

    for (const transfer of page.transfers) {
      const outcome = await ingestTransfer(wallet.id, transfer, db);
      if (outcome === 'CREATED') created++;
      else if (outcome === 'UPDATED') updated++;
    }

    await db.wallet.update({
      where: { id: walletId },
      data: {
        syncCursor: page.cursor,
        lastSyncedAt: new Date(),
        lastSyncStatus: 'OK',
        lastSyncError: null,
      },
    });

    await db.walletSyncRun.update({
      where: { id: run.id },
      data: { status: 'OK', finishedAt: new Date(), fetched, created, updated },
    });

    if (created > 0 || updated > 0) {
      log.info('Wallet synchronised', { walletId, fetched, created, updated });
    }

    emitAsync('wallet.synced', { walletId, created, updated });

    return { walletId, fetched, created, updated, balance, status: 'OK' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await db.wallet.update({
      where: { id: walletId },
      data: { lastSyncedAt: new Date(), lastSyncStatus: 'ERROR', lastSyncError: message.slice(0, 500) },
    });
    await db.walletSyncRun.update({
      where: { id: run.id },
      data: { status: 'ERROR', finishedAt: new Date(), fetched, created, updated, error: message.slice(0, 1000) },
    });

    log.error('Wallet synchronisation failed', { walletId, error: message });

    // A failing explorer must not abort a batch across many wallets.
    return { walletId, fetched, created, updated, balance, status: 'ERROR', error: message };
  }
}

type IngestOutcome = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED';

/**
 * The largest amount a transfer row can hold.
 *
 * The column is a signed 64-bit integer, and the scaled figures this system
 * speaks are eight decimal places wide — so anything at or above this cannot be
 * stored at all.
 *
 * Real transfers never come near it. What does is the scam airdrop: a worthless
 * token sent to thousands of addresses carrying the largest number the standard
 * allows, precisely so that software which trusts it breaks. And it worked —
 * one of them stopped a wallet's sync outright, and a counter whose sync has
 * stopped is blind to every genuine arrival after it.
 *
 * So a transfer that cannot be stored is skipped, loudly, and the poll carries
 * on to the ones that can.
 */
const LARGEST_STORABLE = 2n ** 63n - 1n;

/**
 * Records one on-chain transfer. Idempotent on (wallet, hash, direction), so
 * re-reading the same page — which happens on every poll — never duplicates.
 */
async function ingestTransfer(
  walletId: string,
  transfer: ChainTransfer,
  db: DbClient,
): Promise<IngestOutcome> {
  const wallet = await db.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) return 'UNCHANGED';

  const walletAddress = wallet.address.toLowerCase();
  const isIncoming = transfer.toAddress.toLowerCase() === walletAddress;
  const isOutgoing = transfer.fromAddress.toLowerCase() === walletAddress;

  // A transfer between two monitored wallets appears twice, once per wallet;
  // each row is scoped to its own wallet, so both are correct.
  if (!isIncoming && !isOutgoing) return 'UNCHANGED';
  const direction = isIncoming ? 'IN' : 'OUT';

  /*
   * Checked before anything is written. The amount arrives already scaled by
   * the provider, so this is the figure the column would have to take.
   */
  if (transfer.amount > LARGEST_STORABLE || transfer.amount < 0n) {
    log.warn('Skipped a transfer whose amount cannot be stored', {
      walletId,
      txHash: transfer.txHash,
      tokenSymbol: transfer.tokenSymbol,
      contractAddress: transfer.contractAddress,
    });
    return 'REJECTED';
  }

  const confirmed = transfer.confirmations >= wallet.minConfirmations;
  const status = transfer.status === 'FAILED' ? 'FAILED' : confirmed ? 'CONFIRMED' : 'PENDING';

  const existing = await db.chainTransaction.findUnique({
    where: { walletId_txHash_direction: { walletId, txHash: transfer.txHash, direction } },
  });

  if (existing) {
    // Only the volatile fields move as a transfer matures.
    if (existing.confirmations === transfer.confirmations && existing.status === status) {
      return 'UNCHANGED';
    }

    await db.chainTransaction.update({
      where: { id: existing.id },
      data: { confirmations: transfer.confirmations, status },
    });

    // Crossing the confirmation threshold is the moment it becomes real.
    if (existing.status !== 'CONFIRMED' && status === 'CONFIRMED') {
      emitAsync('chain.transaction.confirmed', {
        chainTransactionId: existing.id,
        walletId,
        direction,
      });
      await onConfirmed(existing.id, db);
    }

    return 'UPDATED';
  }

  const record = await db.chainTransaction.create({
    data: {
      walletId,
      txHash: transfer.txHash,
      network: wallet.network,
      direction,
      fromAddress: transfer.fromAddress,
      toAddress: transfer.toAddress,
      amount: transfer.amount,
      tokenSymbol: transfer.tokenSymbol,
      contractAddress: transfer.contractAddress,
      blockNumber: transfer.blockNumber,
      blockTimestamp: transfer.blockTimestamp,
      confirmations: transfer.confirmations,
      networkFee: transfer.networkFee,
      status,
      notes: transfer.memo ?? null,
    },
  });

  emitAsync('chain.transaction.detected', {
    chainTransactionId: record.id,
    walletId,
    direction,
    amount: transfer.amount.toString(),
    txHash: transfer.txHash,
  });

  await notifyTransfer(record.id, db);
  if (status === 'CONFIRMED') await onConfirmed(record.id, db);

  return 'CREATED';
}

async function notifyTransfer(chainTransactionId: string, db: DbClient): Promise<void> {
  const record = await db.chainTransaction.findUnique({
    where: { id: chainTransactionId },
    include: { wallet: true },
  });
  if (!record) return;

  const incoming = record.direction === 'IN';
  if (incoming && !record.wallet.notifyOnIncoming) return;
  if (!incoming && !record.wallet.notifyOnOutgoing) return;

  const amount = `${toDecimalString(record.amount, 6)} ${record.tokenSymbol}`;
  const counterparty = maskAddress(incoming ? record.fromAddress : record.toAddress);

  await notifications.notify(
    {
      severity: incoming ? 'SUCCESS' : 'INFO',
      eventKey: incoming ? 'usdt.incoming' : 'usdt.outgoing',
      module: 'usdt',
      titleEn: incoming ? 'USDT received' : 'USDT sent',
      titleAr: incoming ? 'استلام USDT' : 'إرسال USDT',
      bodyEn: `${amount} ${incoming ? 'received into' : 'sent from'} "${record.wallet.label}" ${incoming ? 'from' : 'to'} ${counterparty}`,
      bodyAr: `${amount} ${incoming ? 'واردة إلى' : 'صادرة من'} "${record.wallet.labelAr}" ${incoming ? 'من' : 'إلى'} ${counterparty}`,
      entityType: 'ChainTransaction',
      entityId: record.id,
      link: `/usdt/transactions/${record.id}`,
      payload: {
        txHash: record.txHash,
        amount: record.amount.toString(),
        network: record.network,
      },
    },
    { permission: 'usdt.transaction.view' },
    db,
  );
}

/**
 * Runs once a transfer reaches the wallet's confirmation threshold.
 *
 * It deliberately creates nothing. A confirmed transfer proves money arrived at
 * an address, never whose it is — so the only thing that turns one into a
 * transaction is a teller matching it to the customer standing in front of them,
 * through the counter. A transfer nobody claims stays exactly what it is: an
 * unexplained arrival, visible to the manager and settling nothing.
 */
async function onConfirmed(chainTransactionId: string, db: DbClient): Promise<void> {
  const record = await db.chainTransaction.findUnique({
    where: { id: chainTransactionId },
    select: { txHash: true, direction: true },
  });
  if (!record) return;

  log.info('Transfer confirmed', { txHash: record.txHash, direction: record.direction });
}

export async function syncAllWallets(db: DbClient = prisma): Promise<SyncResult[]> {
  const wallets = await db.wallet.findMany({
    where: { isActive: true },
    select: { id: true },
    orderBy: { lastSyncedAt: 'asc' },
  });

  const results: SyncResult[] = [];
  // Sequential on purpose: public explorer APIs rate-limit aggressively, and a
  // burst of parallel requests gets the whole desk throttled.
  for (const wallet of wallets) {
    results.push(await syncWallet(wallet.id, {}, db));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Manual entry & reconciliation
// ---------------------------------------------------------------------------

export interface ManualTransferInput {
  walletId: string;
  txHash: string;
  direction: 'IN' | 'OUT';
  fromAddress: string;
  toAddress: string;
  amount: bigint;
  blockNumber?: bigint | null;
  blockTimestamp?: Date | null;
  notes?: string;
}

/** Records a transfer observed off-system — the manual provider's entry point. */
export async function recordManualTransfer(
  input: ManualTransferInput,
  actor: { id: string; name: string; ip?: string | null; sessionId?: string },
  db: DbClient = prisma,
): Promise<string> {
  return withTransaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { id: input.walletId } });
    if (!wallet) throw errors.notFound('Wallet', input.walletId);

    if (input.amount <= 0n) {
      throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
    }

    const duplicate = await tx.chainTransaction.findUnique({
      where: {
        walletId_txHash_direction: {
          walletId: input.walletId,
          txHash: input.txHash,
          direction: input.direction,
        },
      },
    });
    if (duplicate) {
      throw errors.conflict('This transaction hash is already recorded', 'errors.txHashExists');
    }

    const record = await tx.chainTransaction.create({
      data: {
        walletId: input.walletId,
        txHash: input.txHash,
        network: wallet.network,
        direction: input.direction,
        fromAddress: input.fromAddress,
        toAddress: input.toAddress,
        amount: input.amount,
        tokenSymbol: wallet.tokenSymbol,
        contractAddress: wallet.contractAddress,
        blockNumber: input.blockNumber ?? null,
        blockTimestamp: input.blockTimestamp ?? new Date(),
        confirmations: wallet.minConfirmations,
        status: 'CONFIRMED',
        notes: input.notes ?? null,
      },
    });

    // Keep the mirrored balance consistent with what was just recorded.
    const delta = input.direction === 'IN' ? input.amount : -input.amount;
    await tx.wallet.update({
      where: { id: input.walletId },
      data: { balance: { increment: delta }, balanceUpdatedAt: new Date() },
    });

    await audit.record(
      {
        action: 'CREATE',
        module: 'usdt',
        entityType: 'ChainTransaction',
        entityId: record.id,
        summaryEn: `Recorded manual ${input.direction === 'IN' ? 'incoming' : 'outgoing'} transfer of ${toDecimalString(input.amount, 6)} ${wallet.tokenSymbol}`,
        summaryAr: `تسجيل تحويل ${input.direction === 'IN' ? 'وارد' : 'صادر'} يدوياً بمبلغ ${toDecimalString(input.amount, 6)} ${wallet.tokenSymbol}`,
        actor,
        after: { txHash: input.txHash, amount: input.amount.toString(), direction: input.direction },
      },
      tx,
    );

    return record.id;
  }, db);
}

export async function markReconciled(
  chainTransactionId: string,
  actor: { id: string; name: string; ip?: string | null; sessionId?: string },
  db: DbClient = prisma,
): Promise<void> {
  const record = await db.chainTransaction.findUnique({ where: { id: chainTransactionId } });
  if (!record) throw errors.notFound('Chain transaction', chainTransactionId);

  await db.chainTransaction.update({
    where: { id: chainTransactionId },
    data: { isReconciled: true, processedAt: new Date() },
  });

  await audit.record(
    {
      action: 'UPDATE',
      module: 'usdt',
      entityType: 'ChainTransaction',
      entityId: chainTransactionId,
      summaryEn: `Marked transfer ${record.txHash.slice(0, 14)}… as reconciled`,
      summaryAr: `تعليم التحويل ${record.txHash.slice(0, 14)}… كمسوّى`,
      actor,
    },
    db,
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ChainTransactionFilter {
  walletId?: string;
  direction?: 'IN' | 'OUT';
  status?: string;
  reconciled?: boolean;
  search?: string;
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export async function listChainTransactions(
  filter: ChainTransactionFilter,
  db: DbClient = prisma,
) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 25));

  const where = {
    ...(filter.walletId ? { walletId: filter.walletId } : {}),
    ...(filter.direction ? { direction: filter.direction } : {}),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.reconciled !== undefined ? { isReconciled: filter.reconciled } : {}),
    ...(filter.from || filter.to
      ? {
          blockTimestamp: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
    ...(filter.search
      ? {
          OR: [
            { txHash: containsInsensitive(filter.search) },
            { fromAddress: containsInsensitive(filter.search) },
            { toAddress: containsInsensitive(filter.search) },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.chainTransaction.findMany({
      where,
      orderBy: [{ blockTimestamp: 'desc' }, { firstSeenAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        wallet: { select: { id: true, label: true, labelAr: true, network: true, address: true } },
        linkedTransaction: { select: { id: true, reference: true, status: true } },
      },
    }),
    db.chainTransaction.count({ where }),
  ]);

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
