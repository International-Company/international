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
  type ProviderCredentials,
  type TransferPage,
} from './types';

/**
 * Ethereum (ERC-20) provider backed by the Etherscan API.
 *
 * Etherscan requires an API key for anything beyond a trivial rate limit, so
 * `isConfigured()` reports false without one and the wallet is left untouched
 * rather than being marked failed on every poll.
 */

const log = createLogger('usdt:ethereum');

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

interface EtherscanTransfer {
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenSymbol: string;
  tokenDecimal: string;
  contractAddress: string;
  blockNumber: string;
  timeStamp: string;
  confirmations: string;
  gasUsed?: string;
  gasPrice?: string;
}

interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T;
}

export class EthereumProvider implements ChainProvider {
  readonly network = 'ETHEREUM' as const;
  readonly name = 'Etherscan';

  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: { baseUrl?: string; apiKey?: string } = {}) {
    this.baseUrl = options.baseUrl ?? env.ETH_API_BASE;
    this.apiKey = options.apiKey ?? env.ETH_API_KEY;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /** Etherscan has no usable anonymous tier, so no key means it cannot poll. */
  credentials(): ProviderCredentials {
    return this.apiKey.length > 0 ? 'KEYED' : 'ANONYMOUS';
  }

  validateAddress(address: string): boolean {
    return ADDRESS_PATTERN.test(address);
  }

  explorerUrl(txHash: string): string {
    return `https://etherscan.io/tx/${txHash}`;
  }

  private async request<T>(params: Record<string, string>): Promise<T> {
    if (!this.isConfigured()) {
      throw errors.external('Etherscan API key is not configured');
    }

    const url = new URL(this.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('apikey', this.apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);

    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        throw errors.external(`Etherscan responded ${response.status}`);
      }

      const body = (await response.json()) as EtherscanResponse<T>;

      // Etherscan reports "no records found" as a status of 0, which is a
      // successful empty result rather than a failure.
      if (body.status === '0' && !/no (transactions|records) found/i.test(body.message)) {
        throw errors.external(`Etherscan: ${body.message}`);
      }

      return body.result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw errors.external('Etherscan request timed out');
      }
      throw errors.external('Etherscan', error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async fetchBalance(address: string, contractAddress?: string | null): Promise<bigint> {
    if (!this.validateAddress(address)) {
      throw errors.validation([{ path: 'address', message: 'Not a valid Ethereum address' }]);
    }

    const raw = await this.request<string>({
      module: 'account',
      action: 'tokenbalance',
      contractaddress: contractAddress ?? env.ETH_USDT_CONTRACT,
      address,
      tag: 'latest',
    });

    return fromTokenUnits(raw || '0', USDT_DECIMALS);
  }

  async currentBlock(): Promise<bigint | null> {
    try {
      const hex = await this.request<string>({ module: 'proxy', action: 'eth_blockNumber' });
      return BigInt(hex);
    } catch (error) {
      log.warn('Could not read current Ethereum block height', { error });
      return null;
    }
  }

  async fetchTransfers(
    address: string,
    contractAddress: string | null,
    options: FetchOptions = {},
  ): Promise<TransferPage> {
    if (!this.validateAddress(address)) {
      throw errors.validation([{ path: 'address', message: 'Not a valid Ethereum address' }]);
    }

    const limit = Math.min(200, options.limit ?? 50);
    // The cursor is the last block we ingested; resuming from it avoids
    // re-reading the entire history on every poll.
    const startBlock = options.cursor ?? (options.sinceBlock ? String(options.sinceBlock) : '0');

    const result = await this.request<EtherscanTransfer[] | string>({
      module: 'account',
      action: 'tokentx',
      contractaddress: contractAddress ?? env.ETH_USDT_CONTRACT,
      address,
      startblock: startBlock,
      endblock: '99999999',
      page: '1',
      offset: String(limit),
      sort: 'desc',
    });

    const rows = Array.isArray(result) ? result : [];

    const transfers: ChainTransfer[] = rows.map((item) => {
      const decimals = Number(item.tokenDecimal) || USDT_DECIMALS;
      const gasFee =
        item.gasUsed && item.gasPrice
          ? fromTokenUnits(BigInt(item.gasUsed) * BigInt(item.gasPrice), 18)
          : 0n;

      return {
        txHash: item.hash,
        fromAddress: item.from,
        toAddress: item.to,
        amount: fromTokenUnits(item.value, decimals),
        tokenSymbol: item.tokenSymbol || 'USDT',
        contractAddress: item.contractAddress,
        blockNumber: BigInt(item.blockNumber || '0'),
        blockTimestamp: new Date(Number(item.timeStamp) * 1000),
        confirmations: Number(item.confirmations) || 0,
        status: 'CONFIRMED',
        networkFee: gasFee,
      };
    });

    const highestBlock = transfers.reduce(
      (max, t) => (t.blockNumber && t.blockNumber > max ? t.blockNumber : max),
      0n,
    );

    return {
      transfers,
      cursor: highestBlock > 0n ? String(highestBlock + 1n) : options.cursor ?? null,
      hasMore: transfers.length === limit,
    };
  }
}
