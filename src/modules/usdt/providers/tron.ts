import 'server-only';
import { createHash } from 'node:crypto';
import { env } from '@/core/config/env';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import {
  fromTokenUnits,
  USDT_DECIMALS,
  type ChainProvider,
  type ChainTransfer,
  type FetchOptions,
  type ProviderCredentials,
  type TransferPage,
} from './types';

/**
 * TRON (TRC-20) provider backed by the public TronGrid API.
 *
 * TRON carries the large majority of USDT settlement volume in this region,
 * which is why it is the default network.
 */

const log = createLogger('usdt:tron');

/** How far behind the newest transfer seen each poll reads again. */
const REREAD_MS = 30 * 60 * 1000;

/** Pages followed inside that window before leaving the rest to the next poll. */
const MAX_PAGES = 4;

/** Base58 TRON mainnet addresses always start with `T` and are 34 chars. */
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * A contract event's address, `0x` and twenty bytes, as TRON writes it: the
 * mainnet prefix, a double-SHA-256 checksum, base58. Null for anything else.
 */
export function tronAddress(hex: string): string | null {
  const body = hex.replace(/^0x/i, '').replace(/^41/, '');
  if (!/^[0-9a-fA-F]{40}$/.test(body)) return null;
  const payload = Buffer.from(`41${body}`, 'hex');
  const check = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest();
  const bytes = Buffer.concat([payload, check.subarray(0, 4)]);
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

interface TronTrc20Transfer {
  transaction_id: string;
  from: string;
  to: string;
  value: string;
  block_timestamp: number;
  token_info?: { symbol?: string; decimals?: number; address?: string };
}

interface TronListResponse<T> {
  success?: boolean;
  data?: T[];
  meta?: { fingerprint?: string; links?: { next?: string } };
  error?: string;
}

export class TronProvider implements ChainProvider {
  readonly network = 'TRON' as const;
  readonly name = 'TronGrid';

  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: { baseUrl?: string; apiKey?: string } = {}) {
    this.baseUrl = (options.baseUrl ?? env.TRON_API_BASE).replace(/\/+$/, '');
    this.apiKey = options.apiKey ?? env.TRON_API_KEY;
  }

  /**
   * Set once TronGrid has refused the configured key.
   *
   * Process-lifetime rather than persisted: a key is usually fixed by editing
   * the environment, which restarts the server anyway, and a stored flag would
   * have to be cleared by hand after the fix.
   */
  private keyRejected = false;

  /** TronGrid serves unauthenticated requests at a low rate limit. */
  isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  credentials(): ProviderCredentials {
    if (this.apiKey.length === 0) return 'ANONYMOUS';
    return this.keyRejected ? 'REJECTED' : 'KEYED';
  }

  validateAddress(address: string): boolean {
    return ADDRESS_PATTERN.test(address);
  }

  explorerUrl(txHash: string): string {
    return `https://tronscan.org/#/transaction/${txHash}`;
  }

  /** One HTTP round trip, authenticated or not. Never throws on a status. */
  private async send(
    path: string,
    params: Record<string, string>,
    authenticated: boolean,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== '') url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      return await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(authenticated && this.apiKey ? { 'TRON-PRO-API-KEY': this.apiKey } : {}),
        },
        signal: controller.signal,
        cache: 'no-store',
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * A request, with one fallback.
   *
   * A key TronGrid does not recognise is worse than no key at all: the public
   * tier answers an anonymous request, while an unknown key earns a flat 401.
   * So a key that has been refused is retired for the life of the process and
   * the request is repeated unauthenticated — monitoring degrades to the free
   * tier rather than stopping dead the moment a key is revoked or mistyped in
   * a deployment variable. The refusal is logged at error level and reported
   * through `credentials()`, so this is a visible degradation, not a silent
   * one.
   */
  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    try {
      let response = await this.send(path, params, !this.keyRejected);

      if (response.status === 401 && this.apiKey.length > 0 && !this.keyRejected) {
        this.keyRejected = true;
        log.error('TronGrid refused the configured API key — falling back to the public tier', {
          status: response.status,
        });
        response = await this.send(path, params, false);
      }

      if (!response.ok) {
        throw errors.external(`TronGrid responded ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw errors.external('TronGrid request timed out');
      }
      throw errors.external('TronGrid', error);
    }
  }

  async fetchBalance(address: string, contractAddress?: string | null): Promise<bigint> {
    if (!this.validateAddress(address)) {
      throw errors.validation([{ path: 'address', message: 'Not a valid TRON address' }]);
    }

    const contract = contractAddress ?? env.TRON_USDT_CONTRACT;
    const response = await this.request<{
      data?: { trc20?: Record<string, string>[] }[];
    }>(`/v1/accounts/${address}`);

    const account = response.data?.[0];
    if (!account) return 0n;

    for (const entry of account.trc20 ?? []) {
      const raw = entry[contract];
      if (raw !== undefined) return fromTokenUnits(raw, USDT_DECIMALS);
    }

    return 0n;
  }

  async currentBlock(): Promise<bigint | null> {
    try {
      const response = await this.request<{ block_header?: { raw_data?: { number?: number } } }>(
        '/wallet/getnowblock',
      );
      const number = response.block_header?.raw_data?.number;
      return number ? BigInt(number) : null;
    } catch (error) {
      log.warn('Could not read current TRON block height', { error });
      return null;
    }
  }

  async fetchTransaction(
    txHash: string,
    address: string,
    contractAddress: string | null,
  ): Promise<ChainTransfer[] | null> {
    if (!this.validateAddress(address)) return [];
    const contract = contractAddress ?? env.TRON_USDT_CONTRACT;
    const response = await this.request<
      TronListResponse<{
        block_number?: number;
        block_timestamp?: number;
        contract_address?: string;
        event_name?: string;
        result?: { from?: string; to?: string; value?: string };
        _unconfirmed?: boolean;
      }>
    >(`/v1/transactions/${txHash}/events`);
    const events = response.data ?? [];
    // TronGrid answers an unknown hash with no events, the same as one without transfers.
    if (events.length === 0) return null;

    return events
      .filter((event) => event.event_name === 'Transfer' && event.contract_address === contract)
      .map((event) => ({
        event,
        from: tronAddress(event.result?.from ?? ''),
        to: tronAddress(event.result?.to ?? ''),
      }))
      .filter(({ from, to }) => from === address || to === address)
      .map(({ event, from, to }) => {
        const timestamp = event.block_timestamp ? new Date(event.block_timestamp) : null;
        return {
          txHash,
          fromAddress: from ?? '',
          toAddress: to ?? '',
          amount: fromTokenUnits(event.result?.value ?? '0', USDT_DECIMALS),
          tokenSymbol: 'USDT',
          contractAddress: contract,
          blockNumber: event.block_number ? BigInt(event.block_number) : null,
          blockTimestamp: timestamp,
          // As the address's list counts them: TRON blocks are ~3s.
          confirmations:
            event._unconfirmed || !timestamp
              ? 0
              : Math.max(0, Math.floor((Date.now() - timestamp.getTime()) / 3000)),
          status: 'CONFIRMED' as const,
          networkFee: 0n,
        };
      });
  }

  async fetchTransfers(
    address: string,
    contractAddress: string | null,
    options: FetchOptions = {},
  ): Promise<TransferPage> {
    if (!this.validateAddress(address)) {
      throw errors.validation([{ path: 'address', message: 'Not a valid TRON address' }]);
    }

    const contract = contractAddress ?? env.TRON_USDT_CONTRACT;
    const limit = Math.min(200, options.limit ?? 50);

    /*
     * The cursor is the newest block time already seen, and every poll reads
     * from the top down to a little before it.
     *
     * Not TronGrid's fingerprint. A fingerprint continues to the next *older*
     * page, so storing it made every poll walk further back into history while
     * a transfer that had just landed sat unread until the walk ran out and
     * started over — minutes, on an address with any past. The margin re-reads
     * the last half hour on purpose: a transfer is seen first with too few
     * confirmations, and has to be read again to be seen as settled.
     */
    const since = options.cursor && /^\d+$/.test(options.cursor) ? Number(options.cursor) : null;
    const minTimestamp = since !== null ? String(since - REREAD_MS) : '';

    const items: TronTrc20Transfer[] = [];
    let fingerprint = '';
    // A few pages at most, and only inside the window: more than that many
    // arrivals in half an hour is not a counter, and the next poll picks up
    // where this one stopped.
    for (let page = 0; page < (since !== null ? MAX_PAGES : 1); page++) {
      const response = await this.request<TronListResponse<TronTrc20Transfer>>(
        `/v1/accounts/${address}/transactions/trc20`,
        {
          limit: String(limit),
          contract_address: contract,
          order_by: 'block_timestamp,desc',
          min_timestamp: minTimestamp,
          fingerprint,
        },
      );

      if (response.success === false) {
        throw errors.external(`TronGrid: ${response.error ?? 'unknown error'}`);
      }

      items.push(...(response.data ?? []));
      fingerprint = response.meta?.fingerprint ?? '';
      if (!fingerprint) break;
    }

    const newest = items.reduce((max, item) => Math.max(max, item.block_timestamp ?? 0), since ?? 0);

    const transfers: ChainTransfer[] = items.map((item) => {
      const decimals = item.token_info?.decimals ?? USDT_DECIMALS;
      const timestamp = item.block_timestamp ? new Date(item.block_timestamp) : null;

      return {
        txHash: item.transaction_id,
        fromAddress: item.from,
        toAddress: item.to,
        amount: fromTokenUnits(item.value, decimals),
        tokenSymbol: item.token_info?.symbol ?? 'USDT',
        contractAddress: item.token_info?.address ?? contract,
        blockNumber: null,
        blockTimestamp: timestamp,
        // TRON blocks are ~3s. Age is a sound proxy when the height is absent.
        confirmations: timestamp
          ? Math.max(0, Math.floor((Date.now() - timestamp.getTime()) / 3000))
          : 0,
        status: 'CONFIRMED',
        networkFee: 0n,
      };
    });

    return {
      transfers,
      cursor: newest > 0 ? String(newest) : null,
      hasMore: Boolean(fingerprint),
    };
  }
}
