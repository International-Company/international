import 'server-only';
import { createHash, createHmac } from 'node:crypto';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import type {
  ChainProvider,
  ChainTransfer,
  FetchOptions,
  ProviderCredentials,
  TransferPage,
  WatchedAddress,
} from './types';

/**
 * The office's Binance account, watched through Binance's own API.
 *
 * A customer who holds USDT at Binance pays the office by Binance Pay — to its
 * Binance ID, inside Binance, with no chain involved. Nothing on any blockchain
 * shows it; only the account's own Pay history does. So this provider reads
 * that history with a key the manager created **read-only**: it can list and
 * it can read balances, and it cannot trade or withdraw, whatever this code
 * did with it.
 *
 * The "address" of such a wallet is the office's Binance ID. A Pay transfer is
 * final the moment it appears — there is nothing to confirm — so each one is
 * reported settled.
 *
 * ## What a sender looks like
 *
 * Binance tells the receiver the payer's **name** only, not their ID. That
 * name stands where an on-chain sender's address would, so the counter shows
 * who paid and the office's recognition of returning senders still works.
 *
 * ## Going easy on the account
 *
 * The Pay history is one of Binance's heaviest calls (3000 weight against the
 * account). Every counter screen asks for fresh arrivals on its own timer, so
 * one account is read at most every {@link MIN_INTERVAL_MS}, and a poll makes
 * at most {@link CALL_BUDGET} calls however far behind it is.
 */

const log = createLogger('usdt:binance');

const BASE_URL = 'https://api.binance.com';

/** Binance IDs and Pay IDs are plain numbers. */
const ID_PATTERN = /^\d{6,12}$/;

const PAGE_LIMIT = 100;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Re-read behind the cursor, for a transfer Binance lists a moment late. */
const OVERLAP_MS = 10 * MINUTE;
/** How far back a new wallet's first poll reaches. */
const FIRST_LOOKBACK_MS = 3 * DAY;
/** A deep sync, asked for by hand: Binance answers for at most 90 days at once. */
const DEEP_LOOKBACK_MS = 30 * DAY;
const CALL_BUDGET = 4;
const MIN_INTERVAL_MS = 15_000;

/** When each account was last read, by a hash of its key — never the key itself. */
const lastRead = new Map<string, number>();

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

interface PayParty {
  name?: string;
  type?: string;
  binanceId?: string | number;
  accountId?: string | number;
  email?: string;
}

export interface PayRecord {
  orderType: string;
  transactionId: string;
  transactionTime: number;
  amount: string;
  currency: string;
  payerInfo?: PayParty;
  receiverInfo?: PayParty;
}

/** One row of the account's deposit history, as Binance lists it. */
export interface DepositRecord {
  id?: string;
  amount: string;
  coin: string;
  network?: string;
  /** 0 pending, 6 credited but not yet withdrawable, 1 done; others failed. */
  status: number;
  address?: string;
  txId?: string;
  insertTime?: number;
  sourceAddress?: string;
}

/** What Binance writes in place of a hash when one of its own users paid. */
const OFF_CHAIN = /^off-?chain transfer\s*(\d+)/i;

/** The number Binance gives an off-chain transfer, or null for one that went over a chain. */
export function offChainId(txId: string | null | undefined): string | null {
  return OFF_CHAIN.exec(String(txId ?? '').trim())?.[1] ?? null;
}

/** Binance's name for a network, as a chain wallet's network is called here. */
const BINANCE_NETWORK: Record<string, string> = { TRON: 'TRX', BSC: 'BSC', ETHEREUM: 'ETH' };

/** Whether a chain wallet already reads this deposit: the same network, address and coin. */
function watchedBy(record: DepositRecord, watched: WatchedAddress[]): boolean {
  const network = record.network?.toUpperCase() ?? '';
  const address = record.address?.trim().toLowerCase() ?? '';
  const coin = record.coin?.toUpperCase() ?? '';
  return watched.some(
    (wallet) =>
      (BINANCE_NETWORK[wallet.network] ?? wallet.network) === network &&
      wallet.address.trim().toLowerCase() === address &&
      wallet.token.toUpperCase() === coin,
  );
}

/**
 * A deposit to one of this account's deposit addresses — any coin, any network
 * — as a transfer on the office's account; null for anything else.
 *
 * Paid from another Binance account, Binance moves it inside itself — "Off-chain
 * transfer 433778693577" where a hash would be — and no chain ever shows it.
 * Paid over a chain, it carries its hash, and it is taken here too, unless a
 * chain wallet watches that address for that coin: that wallet reads it, and
 * taking it twice would offer the same coins to be paid out twice.
 */
export function depositToTransfer(
  record: DepositRecord,
  officeId: string,
  watched: WatchedAddress[] = [],
): ChainTransfer | null {
  const coin = record.coin?.trim().toUpperCase();
  if (!coin) return null;
  const id = offChainId(record.txId);
  const hash = String(record.txId ?? '').trim();
  if (!id && (!hash || watchedBy(record, watched))) return null;
  // Failed or turned back: never money the office holds.
  if (![0, 1, 6].includes(Number(record.status))) return null;
  const amount = parseMoney(String(record.amount ?? '').trim());
  if (amount <= 0n) return null;
  const settled = Number(record.status) !== 0;
  const network = record.network?.toUpperCase() || null;
  return {
    txHash: id ? `Off-chain transfer ${id}` : hash,
    fromAddress: record.sourceAddress?.trim() || 'Binance',
    toAddress: officeId,
    amount,
    tokenSymbol: coin,
    contractAddress: null,
    blockNumber: null,
    blockTimestamp: Number.isFinite(record.insertTime) ? new Date(record.insertTime!) : null,
    confirmations: settled ? 1 : 0,
    status: settled ? 'CONFIRMED' : 'PENDING',
    networkFee: 0n,
    memo: [id ? 'Binance off-chain' : 'Binance deposit', network, record.address ? `→ ${record.address}` : null].filter(Boolean).join(' · '),
  };
}

interface AssetRow {
  asset: string;
  free?: string;
  locked?: string;
  freeze?: string;
}

/**
 * One Pay record as a transfer on the office's account, in whatever coin it was
 * paid. Exported for its tests: this is where a sign error would pay a customer
 * for money that left.
 */
export function payToTransfer(record: PayRecord, officeId: string): ChainTransfer | null {
  const token = record.currency?.trim().toUpperCase();
  if (!token) return null;

  const raw = String(record.amount ?? '').trim();
  const outgoing = raw.startsWith('-');
  const amount = parseMoney(raw.replace(/^-/, ''));
  if (amount <= 0n) return null;

  const party = (who: PayParty | undefined) =>
    String(who?.binanceId || who?.accountId || who?.name || who?.email || 'Binance').trim();

  const counterparty = outgoing ? record.receiverInfo : record.payerInfo;
  const name = counterparty?.name?.trim() || null;

  return {
    txHash: String(record.transactionId),
    fromAddress: outgoing ? officeId : party(record.payerInfo),
    toAddress: outgoing ? party(record.receiverInfo) : officeId,
    amount,
    tokenSymbol: token,
    contractAddress: null,
    blockNumber: null,
    blockTimestamp: Number.isFinite(record.transactionTime)
      ? new Date(record.transactionTime)
      : null,
    // Final on arrival; a Binance wallet asks for one.
    confirmations: 1,
    status: 'CONFIRMED',
    networkFee: 0n,
    memo: [`Binance Pay ${record.orderType}`, name].filter(Boolean).join(' — '),
  };
}

/** What Binance's refusal means, said so a manager can act on it. */
function explain(status: number, body: { code?: number | string; msg?: string; message?: string }) {
  const detail = body.msg ?? body.message ?? '';
  if (status === 451 || /restricted location/i.test(detail)) {
    return 'Binance refuses requests from the server’s location — the server must run outside the United States';
  }
  if (body.code === -2015 || body.code === -2014 || body.code === -1022) {
    return `Binance rejected the API key (${body.code}): ${detail} — check the key, its read permission, and any IP restriction`;
  }
  if (body.code === -1021) {
    return 'The server clock is out of step with Binance';
  }
  if (status === 429 || status === 418) {
    return 'Binance is limiting requests from this account; it will be read again shortly';
  }
  return `Binance responded ${status}${body.code !== undefined ? ` (${body.code})` : ''}: ${detail || 'error'}`;
}

export class BinanceProvider implements ChainProvider {
  readonly network = 'BINANCE' as const;
  readonly name = 'Binance Pay';

  constructor(private readonly credentials_: BinanceCredentials | null = null) {}

  /**
   * Always: the keys belong to each wallet, not to the server, so the network
   * itself is never "unconfigured". A wallet whose keys are missing says so
   * when it is read.
   */
  isConfigured(): boolean {
    return true;
  }

  credentials(): ProviderCredentials {
    return 'KEYED';
  }

  validateAddress(address: string): boolean {
    return ID_PATTERN.test(address.trim());
  }

  /** Binance Pay has no public explorer. */
  explorerUrl(): string {
    return '';
  }

  async currentBlock(): Promise<bigint | null> {
    return null;
  }

  private keys(): BinanceCredentials {
    if (!this.credentials_?.apiKey || !this.credentials_.apiSecret) {
      throw errors.precondition(
        'This Binance wallet has no API key — add a read-only key to the wallet',
        'errors.binanceNoKey',
      );
    }
    return this.credentials_;
  }

  private async signed<T>(
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number>,
  ): Promise<T> {
    const { apiKey, apiSecret } = this.keys();
    const query = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
      recvWindow: '10000',
      timestamp: String(Date.now()),
    }).toString();
    const signature = createHmac('sha256', apiSecret).update(query).digest('hex');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`${BASE_URL}${path}?${query}&signature=${signature}`, {
        method,
        headers: { 'X-MBX-APIKEY': apiKey, accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      const body = (await response.json().catch(() => ({}))) as T & {
        code?: number | string;
        msg?: string;
        message?: string;
      };
      if (!response.ok) throw errors.external(explain(response.status, body));
      return body;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw errors.external('Binance request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** The token held across the funding wallet (where Pay lands) and spot. */
  async fetchBalance(_address: string, _contract?: string | null, token = 'USDT'): Promise<bigint> {
    const [funding, spot] = await Promise.all([
      this.signed<AssetRow[]>('POST', '/sapi/v1/asset/get-funding-asset', { asset: token }),
      this.signed<AssetRow[]>('POST', '/sapi/v3/asset/getUserAsset', { asset: token }),
    ]);
    let total = 0n;
    for (const row of [...(funding ?? []), ...(spot ?? [])]) {
      if (row.asset?.toUpperCase() !== token.toUpperCase()) continue;
      for (const part of [row.free, row.locked, row.freeze]) {
        if (part) total += parseMoney(part);
      }
    }
    return total;
  }

  private async payWindow(startTime: number, endTime: number): Promise<PayRecord[]> {
    const body = await this.signed<{ code?: string; success?: boolean; data?: PayRecord[] }>(
      'GET',
      '/sapi/v1/pay/transactions',
      { startTime, endTime, limit: PAGE_LIMIT },
    );
    if (body.success === false || (body.code && body.code !== '000000')) {
      throw errors.external(`Binance Pay history: ${body.code ?? 'error'}`);
    }
    return body.data ?? [];
  }

  /** Every coin's deposits in the window: Binance lists them all when no coin is named. */
  private async depositWindow(startTime: number, endTime: number): Promise<DepositRecord[]> {
    const rows = await this.signed<DepositRecord[]>('GET', '/sapi/v1/capital/deposit/hisrec', {
      startTime,
      endTime,
      limit: 1000,
      includeSource: 'true',
    });
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * An off-chain deposit named by the number Binance gave it — what the
   * customer reads off their app in place of a hash — from the last 90 days.
   */
  async fetchOffChain(id: string, address: string): Promise<ChainTransfer | null> {
    const now = Date.now();
    const rows = await this.depositWindow(now - 89 * DAY, now);
    const record = rows.find((row) => offChainId(row.txId) === id);
    return record ? depositToTransfer(record, address.trim()) : null;
  }

  async fetchTransfers(
    address: string,
    contractAddress: string | null,
    options: FetchOptions = {},
  ): Promise<TransferPage> {
    const { apiKey } = this.keys();
    const now = Date.now();
    const account = createHash('sha256').update(apiKey).digest('hex');
    const deep = (options.limit ?? 0) > 100;

    // Asked again within the interval: nothing new is worth another heavy call.
    if (!deep && now - (lastRead.get(account) ?? 0) < MIN_INTERVAL_MS) {
      return { transfers: [], cursor: options.cursor ?? null, hasMore: false };
    }
    lastRead.set(account, now);

    const cursor = options.cursor && /^\d+$/.test(options.cursor) ? Number(options.cursor) : null;
    let from =
      cursor !== null ? cursor - OVERLAP_MS : now - (deep ? DEEP_LOOKBACK_MS : FIRST_LOOKBACK_MS);

    /*
     * Forward a day at a time. A window that comes back full may have more in
     * it than Binance returned, so it is halved and read again rather than
     * trusted — until the budget runs out, when what was read is kept and the
     * next poll carries on from there.
     */
    const records: PayRecord[] = [];
    let calls = 0;
    while (from < now && calls < CALL_BUDGET) {
      let to = Math.min(from + DAY, now);
      let rows = await this.payWindow(from, to);
      calls++;
      while (rows.length >= PAGE_LIMIT && to - from > MINUTE && calls < CALL_BUDGET) {
        to = from + Math.floor((to - from) / 2);
        rows = await this.payWindow(from, to);
        calls++;
      }
      if (rows.length >= PAGE_LIMIT) {
        log.warn('A Binance Pay window was full; some transfers in it may be read late', {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
        });
      }
      records.push(...rows);
      from = to + 1;
    }

    // Every coin: what was paid in USDC, BNB or TRX is the account's as much as USDT.
    const transfers = records
      .map((record) => payToTransfer(record, address.trim()))
      .filter((transfer): transfer is ChainTransfer => transfer !== null);

    /*
     * And what reached the account's deposit addresses, any coin on any network:
     * from other Binance users, kept off every chain, and over a chain, unless a
     * chain wallet reads that address already. One light call over the same
     * span — Binance answers up to 90 days at once — and a failure of it does
     * not lose the Pay history already read.
     */
    const since = cursor !== null ? cursor - OVERLAP_MS : now - (deep ? DEEP_LOOKBACK_MS : FIRST_LOOKBACK_MS);
    try {
      const deposits = await this.depositWindow(Math.max(since, now - 89 * DAY), now);
      for (const record of deposits) {
        const transfer = depositToTransfer(record, address.trim(), options.watched ?? []);
        if (transfer) transfers.push(transfer);
      }
    } catch (error) {
      log.warn('Could not read the Binance deposit history', { error });
    }

    return { transfers, cursor: String(Math.min(from, now)), hasMore: from < now };
  }
}
