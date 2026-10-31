import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { toDecimalString } from '@/core/money/money';
import { emitAsync } from '@/core/events/bus';
import { encryptSecret } from '@/core/security/crypto';
import * as audit from '@/modules/audit/audit.service';
import {
  BinanceProvider,
  providerFor,
  strictProviderFor,
  WALLET_KEY_PURPOSE,
} from './providers';

/**
 * Monitored wallets.
 *
 * The system watches an unlimited number of addresses across networks. Each
 * wallet may be linked to a ledger account so its on-chain balance is mirrored
 * into the books, which is what lets the USDT module and the exchange module
 * reconcile against one another.
 */

const log = createLogger('usdt:wallets');

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
  /** A Binance account's read-only API key. */
  apiKey?: string | null;
  apiSecret?: string | null;
}

/**
 * Proves a Binance key before it is kept.
 *
 * A key typed wrong, without read permission, or refused from the server's
 * location would otherwise be stored and fail quietly on every poll, and the
 * counter would simply see nothing arrive. Asked here, the manager is told why
 * while the key is still in front of them.
 */
async function checkedBinanceKey(apiKey?: string | null, apiSecret?: string | null) {
  const key = apiKey?.trim() ?? '';
  const secret = apiSecret?.trim() ?? '';
  if (!key || !secret) {
    throw errors.precondition(
      'A Binance wallet needs its API key and secret',
      'errors.binanceNoKey',
    );
  }
  try {
    await new BinanceProvider({ apiKey: key, apiSecret: secret }).fetchBalance('');
  } catch (error) {
    throw errors.precondition(
      `Binance did not accept the key: ${error instanceof Error ? error.message : String(error)}`,
      'errors.binanceKeyRefused',
      { detail: error instanceof Error ? error.message : String(error) },
    );
  }
  return {
    apiKey: encryptSecret(key, WALLET_KEY_PURPOSE),
    apiSecret: encryptSecret(secret, WALLET_KEY_PURPOSE),
  };
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

  // Checked before the transaction: it is a call to Binance, not to the database.
  const binance = input.network === 'BINANCE';
  const credential = binance ? await checkedBinanceKey(input.apiKey, input.apiSecret) : null;

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
      // The token is held on a chain, so it belongs to the cash side: there is
      // no bank account holding USDT for the branch.
      // The treasury's, always: a monitored wallet is the company's holding,
      // never a teller's — what a teller gets is an allocation against it.
      const drawer = await tx.drawer.findUnique({
        where: {
          ownerKey_currencyCode_kind: {
            ownerKey: 'TREASURY',
            currencyCode: tokenSymbol,
            kind: 'CASH',
          },
        },
      });
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
        // A Pay transfer is final when it appears; there is nothing to wait for.
        minConfirmations: binance ? 1 : (input.minConfirmations ?? 19),
        notifyOnIncoming: input.notifyOnIncoming ?? true,
        notifyOnOutgoing: input.notifyOnOutgoing ?? true,
        autoCreateTransaction: input.autoCreateTransaction ?? true,
        drawerId,
        lastSyncStatus: 'NEVER',
        createdById: actor.id,
        ...(credential ? { credential: { create: credential } } : {}),
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
  // A new Binance key is proved before anything is written, as on creation.
  const rekey = Boolean(input.apiKey?.trim() || input.apiSecret?.trim());
  const credential = rekey ? await checkedBinanceKey(input.apiKey, input.apiSecret) : null;

  return withTransaction(async (tx) => {
    const existing = await tx.wallet.findUnique({ where: { id } });
    if (!existing) throw errors.notFound('Wallet', id);
    if (credential && existing.network !== 'BINANCE') {
      throw errors.precondition('Only a Binance wallet carries an API key');
    }
    if (credential) {
      await tx.walletCredential.upsert({
        where: { walletId: id },
        create: { walletId: id, ...credential },
        update: credential,
      });
    }

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
    // Said, never shown: the audit names the change and keeps no part of the key.
    if (credential) changes.changed.push('apiKey');

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

/**
 * Removes a wallet.
 *
 * ## What used to stop this, and why it was too much
 *
 * Any history at all refused the delete. That is the safe rule and it was the
 * wrong one: an address the office tried once, or a test address, or one the
 * chain happened to send dust to, collects rows that explain nothing — and the
 * screen then refused to let go of an address nobody wanted, forever.
 *
 * ## What stops it now
 *
 * Only history that explains money. A transfer linked to a posting is the
 * evidence behind cash that was paid out or coins that were sent, and a
 * settled counter request is the same. Delete the wallet and those rows go
 * with it — the relation cascades — and whoever later asks "which address did
 * this arrive at" has no answer for a receipt the office already handed over.
 *
 * Everything else goes. Unclaimed arrivals, requests nobody finished, dust:
 * none of it is behind a posting, so none of it is evidence.
 *
 * Deactivating remains for the address that *is* behind money and is simply
 * finished with: it stops being offered and stops being polled, and everything
 * it explains stays readable. The two are different acts and the screen says so.
 */
export async function deleteWallet(id: string, actor: Actor, db: DbClient = prisma): Promise<void> {
  await withTransaction(async (tx) => {
    const wallet = await tx.wallet.findUnique({ where: { id } });
    if (!wallet) throw errors.notFound('Wallet', id);

    /*
     * Counted as "behind a posting", not as "exists". A transfer with no
     * `linkedTransactionId` was never paid out against; a request that never
     * completed settled nothing.
     */
    const [posted, settled, transfers, requests] = await Promise.all([
      tx.chainTransaction.count({ where: { walletId: id, linkedTransactionId: { not: null } } }),
      tx.usdtDepositRequest.count({ where: { walletId: id, status: 'COMPLETED' } }),
      tx.chainTransaction.count({ where: { walletId: id } }),
      tx.usdtDepositRequest.count({ where: { walletId: id } }),
    ]);

    if (posted + settled > 0) {
      throw errors.conflict(
        `"${wallet.label}" is the address behind ${posted} settled transfer(s) and ${settled} completed request(s), so deleting it would erase the evidence for money that moved — deactivate it instead`,
        'errors.walletHasHistory',
        { label: wallet.label, transfers: posted, requests: settled },
      );
    }

    /*
     * A sale still waiting to be sent from this address would be left pointing
     * at a wallet that no longer exists — and it is a promise the office has
     * already taken money for. Finish or reverse it first.
     */
    const promised = await tx.transaction.count({
      where: { payoutWalletId: id, status: 'PENDING_TRANSFER' },
    });
    if (promised > 0) {
      throw errors.conflict(
        `"${wallet.label}" has ${promised} sale(s) still waiting to be sent from it`,
        'errors.walletHasPending',
        { label: wallet.label, count: promised },
      );
    }

    await audit.record(
      {
        action: 'WALLET_CHANGE',
        module: 'usdt',
        entityType: 'Wallet',
        entityId: id,
        summaryEn: `Deleted wallet "${wallet.label}" (${wallet.network} ${maskAddress(wallet.address)}) with ${transfers} unposted transfer(s) and ${requests} unfinished request(s)`,
        summaryAr: `حذف المحفظة "${wallet.labelAr}" (${wallet.network} ${maskAddress(wallet.address)}) ومعها ${transfers} تحويلاً غير مرحّل و${requests} طلباً غير منتهٍ`,
        actor,
        before: { label: wallet.label, network: wallet.network, address: wallet.address },
      },
      tx,
    );

    await tx.wallet.delete({ where: { id } });
  }, db);

  log.warn('Wallet deleted', { id, by: actor.id });
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
