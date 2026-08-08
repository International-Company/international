import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';
import { providerFor, strictProviderFor } from './providers';

/**
 * Monitored wallets.
 *
 * The system watches an unlimited number of addresses across networks. Each
 * wallet may be linked to a ledger account so its on-chain balance is mirrored
 * into the books, which is what lets the USDT module and the exchange module
 * reconcile against one another.
 */

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
}

export interface CreateWalletInput {
  label: string;
  labelAr: string;
  network: string;
  address: string;
  contractAddress?: string | null;
  tokenSymbol?: string;
  isWatchOnly?: boolean;
  minConfirmations?: number;
  notifyOnIncoming?: boolean;
  notifyOnOutgoing?: boolean;
  autoCreateTransaction?: boolean;
  linkToLedger?: boolean;
}

export async function createWallet(
  input: CreateWalletInput,
  actor: Actor,
  db: DbClient = prisma,
) {
  const provider = strictProviderFor(input.network);
  if (!provider) throw errors.precondition(`Unsupported network: ${input.network}`);

  const address = input.address.trim();
  if (!provider.validateAddress(address)) {
    throw errors.validation([
      { path: 'address', message: `Not a valid ${input.network} address` },
    ]);
  }

  return withTransaction(async (tx) => {
    const tokenSymbol = input.tokenSymbol ?? 'USDT';

    const duplicate = await tx.wallet.findUnique({
      where: { network_address_tokenSymbol: { network: input.network, address, tokenSymbol } },
    });
    if (duplicate) {
      throw errors.conflict('This address is already monitored', 'errors.walletExists');
    }

    // A monitored address counts towards the USDT drawer, so what the chain
    // says we hold and what the counter can pay out are the same number.
    let drawerId: string | null = null;
    if (input.linkToLedger !== false) {
      const drawer = await tx.drawer.findUnique({ where: { currencyCode: tokenSymbol } });
      drawerId = drawer?.id ?? null;
    }

    const wallet = await tx.wallet.create({
      data: {
        label: input.label,
        labelAr: input.labelAr,
        network: input.network,
        address,
        contractAddress: input.contractAddress ?? null,
        tokenSymbol,
        isWatchOnly: input.isWatchOnly ?? true,
        minConfirmations: input.minConfirmations ?? 19,
        notifyOnIncoming: input.notifyOnIncoming ?? true,
        notifyOnOutgoing: input.notifyOnOutgoing ?? true,
        autoCreateTransaction: input.autoCreateTransaction ?? true,
        drawerId,
        lastSyncStatus: 'NEVER',
        createdById: actor.id,
      },
    });

    await audit.record(
      {
        action: 'WALLET_CHANGE',
        module: 'usdt',
        entityType: 'Wallet',
        entityId: wallet.id,
        summaryEn: `Added ${input.network} wallet "${input.label}" (${maskAddress(address)})`,
        summaryAr: `إضافة محفظة ${input.network} "${input.labelAr}" (${maskAddress(address)})`,
        actor,
        after: { label: input.label, network: input.network, address, tokenSymbol },
      },
      tx,
    );

    emitAsync('wallet.created', {
      walletId: wallet.id,
      address,
      network: input.network,
      actorId: actor.id,
    });

    return wallet;
  }, db);
}

export async function updateWallet(
  id: string,
  input: Partial<CreateWalletInput> & {
    isActive?: boolean;
    isCounterAddress?: boolean;
    counterSortOrder?: number;
  },
  actor: Actor,
  db: DbClient = prisma,
) {
  return withTransaction(async (tx) => {
    const existing = await tx.wallet.findUnique({ where: { id } });
    if (!existing) throw errors.notFound('Wallet', id);

    // The address identifies the wallet. Changing it would silently reattach a
    // history of transfers to a different account holder.
    if (input.address && input.address.trim() !== existing.address) {
      throw errors.precondition(
        'A wallet address cannot be changed — deactivate this wallet and add the new address',
        'errors.walletAddressImmutable',
      );
    }

    const updated = await tx.wallet.update({
      where: { id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.labelAr !== undefined ? { labelAr: input.labelAr } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.isWatchOnly !== undefined ? { isWatchOnly: input.isWatchOnly } : {}),
        ...(input.minConfirmations !== undefined
          ? { minConfirmations: input.minConfirmations }
          : {}),
        ...(input.notifyOnIncoming !== undefined
          ? { notifyOnIncoming: input.notifyOnIncoming }
          : {}),
        ...(input.notifyOnOutgoing !== undefined
          ? { notifyOnOutgoing: input.notifyOnOutgoing }
          : {}),
        ...(input.autoCreateTransaction !== undefined
          ? { autoCreateTransaction: input.autoCreateTransaction }
          : {}),
        ...(input.isCounterAddress !== undefined
          ? { isCounterAddress: input.isCounterAddress }
          : {}),
        ...(input.counterSortOrder !== undefined
          ? { counterSortOrder: input.counterSortOrder }
          : {}),
      },
    });

    const changes = audit.diff(
      existing as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
    );

    await audit.record(
      {
        action: 'WALLET_CHANGE',
        module: 'usdt',
        entityType: 'Wallet',
        entityId: id,
        summaryEn: `Updated wallet "${existing.label}" (${changes.changed.join(', ') || 'no changes'})`,
        summaryAr: `تعديل المحفظة "${existing.labelAr}" (${changes.changed.join('، ') || 'بدون تغييرات'})`,
        actor,
        before: changes.before,
        after: changes.after,
      },
      tx,
    );

    return updated;
  }, db);
}

export async function listWallets(
  options: { includeInactive?: boolean } = {},
  db: DbClient = prisma,
) {
  const wallets = await db.wallet.findMany({
    where: options.includeInactive ? {} : { isActive: true },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    include: {
      drawer: { select: { id: true, currencyCode: true, nameEn: true, nameAr: true, balance: true } },
      _count: { select: { transactions: true } },
    },
  });

  return wallets.map((wallet) => ({
    ...wallet,
    explorerUrl: providerFor(wallet.network).explorerUrl(''),
    maskedAddress: maskAddress(wallet.address),
  }));
}

export async function getWallet(id: string, db: DbClient = prisma) {
  const wallet = await db.wallet.findUnique({
    where: { id },
    include: {
      drawer: { select: { id: true, currencyCode: true, nameEn: true, nameAr: true, balance: true } },
      syncRuns: { orderBy: { startedAt: 'desc' }, take: 10 },
      snapshots: { orderBy: { at: 'desc' }, take: 30 },
    },
  });
  if (!wallet) throw errors.notFound('Wallet', id);
  return wallet;
}

/** Aggregate position across every monitored wallet, per token. */
export async function portfolio(db: DbClient = prisma) {
  const wallets = await db.wallet.findMany({
    where: { isActive: true },
    select: { tokenSymbol: true, balance: true, network: true },
  });

  const byToken = new Map<string, { total: bigint; wallets: number }>();
  const byNetwork = new Map<string, { total: bigint; wallets: number }>();

  for (const wallet of wallets) {
    const token = byToken.get(wallet.tokenSymbol) ?? { total: 0n, wallets: 0 };
    token.total += wallet.balance;
    token.wallets++;
    byToken.set(wallet.tokenSymbol, token);

    const network = byNetwork.get(wallet.network) ?? { total: 0n, wallets: 0 };
    network.total += wallet.balance;
    network.wallets++;
    byNetwork.set(wallet.network, network);
  }

  return {
    byToken: [...byToken].map(([token, stats]) => ({ token, ...stats })),
    byNetwork: [...byNetwork].map(([network, stats]) => ({ network, ...stats })),
    walletCount: wallets.length,
  };
}

/**
 * Manually records a balance. Used with the manual provider, and to correct a
 * wallet whose explorer is unreachable.
 */
export async function setBalance(
  id: string,
  balance: bigint,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { id } });
    if (!wallet) throw errors.notFound('Wallet', id);

    await tx.wallet.update({
      where: { id },
      data: { balance, balanceUpdatedAt: new Date() },
    });
    await tx.walletSnapshot.create({ data: { walletId: id, balance } });

    await audit.record(
      {
        action: 'WALLET_CHANGE',
        module: 'usdt',
        entityType: 'Wallet',
        entityId: id,
        summaryEn: `Wallet "${wallet.label}" balance set to ${toDecimalString(balance, 6)} ${wallet.tokenSymbol}`,
        summaryAr: `تحديث رصيد المحفظة "${wallet.labelAr}" إلى ${toDecimalString(balance, 6)} ${wallet.tokenSymbol}`,
        actor,
        before: { balance: wallet.balance.toString() },
        after: { balance: balance.toString() },
      },
      tx,
    );
  }, db);
}

/** Addresses are long and error-prone to read; show the ends only. */
export function maskAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}
