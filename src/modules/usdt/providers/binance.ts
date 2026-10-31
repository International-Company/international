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

interface AssetRow {
  asset: string;
  free?: string;
  locked?: string;
  freeze?: string;
}

/**
 * One Pay record as a transfer on the office's account, or null when it is not
 * in the token watched. Exported for its tests: this is where a sign error
 * would pay a customer for money that left.
 */
export function payToTransfer(
  record: PayRecord,
  officeId: string,
  token: string,
): ChainTransfer | null {
  if (record.currency?.toUpperCase() !== token.toUpperCase()) return null;

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

    const token = (contractAddress || 'USDT').toUpperCase();
    const transfers = records
      .map((record) => payToTransfer(record, address.trim(), token))
      .filter((transfer): transfer is ChainTransfer => transfer !== null);

    return { transfers, cursor: String(Math.min(from, now)), hasMore: from < now };
  }
}
