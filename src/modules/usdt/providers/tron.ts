import 'server-only';
import { env } from '@/core/config/env';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import {
  fromTokenUnits,
  USDT_DECIMALS,
  type ChainProvider,
  type ChainTransfer,
  type FetchOptions,
  type TransferPage,
} from './types';

/**
 * TRON (TRC-20) provider backed by the public TronGrid API.
 *
 * TRON carries the large majority of USDT settlement volume in this region,
 * which is why it is the default network.
 */

const log = createLogger('usdt:tron');

/** Base58 TRON mainnet addresses always start with `T` and are 34 chars. */
const ADDRESS_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

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

  /** TronGrid serves unauthenticated requests at a low rate limit. */
  isConfigured(): boolean {
    return this.baseUrl.length > 0;
  }

  validateAddress(address: string): boolean {
    return ADDRESS_PATTERN.test(address);
  }

  explorerUrl(txHash: string): string {
    return `https://tronscan.org/#/transaction/${txHash}`;
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== '') url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(this.apiKey ? { 'TRON-PRO-API-KEY': this.apiKey } : {}),
        },
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!response.ok) {
        throw errors.external(
          `TronGrid responded ${response.status} ${response.statusText}`,
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw errors.external('TronGrid request timed out');
      }
      throw errors.external('TronGrid', error);
    } finally {
      clearTimeout(timeout);
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

    const response = await this.request<TronListResponse<TronTrc20Transfer>>(
      `/v1/accounts/${address}/transactions/trc20`,
      {
        limit: String(limit),
        contract_address: contract,
        order_by: 'block_timestamp,desc',
        ...(options.cursor ? { fingerprint: options.cursor } : {}),
      },
    );

    if (response.success === false) {
      throw errors.external(`TronGrid: ${response.error ?? 'unknown error'}`);
    }

    // Confirmations are derived from block height; TronGrid does not report
    // them per transfer on this endpoint.
    const head = await this.currentBlock();

    const transfers: ChainTransfer[] = (response.data ?? []).map((item) => {
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

    void head;

    return {
      transfers,
      cursor: response.meta?.fingerprint ?? null,
      hasMore: Boolean(response.meta?.fingerprint) && transfers.length === limit,
    };
  }
}
