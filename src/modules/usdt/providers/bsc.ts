import 'server-only';
import { env } from '@/core/config/env';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import {
  fromTokenUnits,
  type ChainProvider,
  type ChainTransfer,
  type FetchOptions,
  type ProviderCredentials,
  type TransferPage,
} from './types';

/**
 * BNB Smart Chain (BEP-20) provider, read straight from a node over JSON-RPC.
 *
 * ## Why a node and not an explorer
 *
 * BscScan's API was retired into Etherscan's, and Etherscan no longer serves
 * BNB Chain on its free tier. The node answers the same question from the
 * source: every USDT `Transfer` log whose recipient is this address. Any RPC
 * that supports `eth_getLogs` will do — a public one by default, a keyed one
 * (NodeReal, Ankr, QuickNode…) through `BSC_RPC_URL` when the volume calls
 * for it.
 *
 * ## The cursor
 *
 * It is the next block to read. A poll re-reads a short window behind it on
 * purpose — a transfer is first seen with too few confirmations and has to be
 * seen again to settle — then walks forward in ranges a node will accept,
 * a bounded number per poll, so a wallet that has been silent for a while
 * catches up over a few polls instead of one request that times out.
 *
 * ## How far back it can see
 *
 * A public node keeps only recent logs — about 9,000 blocks, two hours — and
 * calls anything older an archive request it will not serve. The background
 * sync runs every two minutes, so in normal running it never needs more. If
 * the server was down longer than that, the poll starts at the oldest block
 * the node will still answer for and says so in the log: transfers in the gap
 * are not seen until a keyed archive RPC is set in `BSC_RPC_URL` and
 * `BSC_MAX_REACH` raised.
 *
 * ## What it reads
 *
 * Incoming transfers only. A deposit address at an exchange is swept by the
 * exchange the moment coins land; those sweeps are the exchange's business,
 * and reading them would double every call for nothing the counter acts on.
 *
 * USDT on BNB Chain has 18 decimals, not 6 — read from the chain's own
 * contract, scaled down to the system's eight.
 */

const log = createLogger('usdt:bsc');

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const USDT_BEP20_DECIMALS = 18;

/** Blocks re-read behind the cursor, so a young transfer is seen again (~3 min). */
const REREAD_BLOCKS = 240n;

/** How far back the very first poll of a new wallet reaches (~75 minutes). */
const FIRST_LOOKBACK = 6_000n;

/** The most ranges one poll will read before handing over to the next. */
const MAX_RANGES = 20;

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}

interface RpcBlock {
  timestamp: string;
}

const pad = (address: string) => `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const unpad = (topic: string) => `0x${topic.slice(-40)}`;
const hex = (value: bigint) => `0x${value.toString(16)}`;

export class BscProvider implements ChainProvider {
  readonly network = 'BSC' as const;
  readonly name = 'BNB Smart Chain RPC';

  private readonly rpcUrl: string;
  private readonly keyed: boolean;
  private readonly contract: string;
  private readonly range: bigint;
  private readonly reach: bigint;
  private requestId = 0;

  constructor(
    options: { rpcUrl?: string; contract?: string; range?: number; reach?: number } = {},
  ) {
    this.keyed = Boolean(options.rpcUrl ?? env.BSC_RPC_URL);
    this.rpcUrl = options.rpcUrl ?? (env.BSC_RPC_URL || 'https://bsc-rpc.publicnode.com');
    this.contract = (options.contract ?? env.BSC_USDT_CONTRACT).toLowerCase();
    this.range = BigInt(options.range ?? env.BSC_LOG_RANGE);
    this.reach = BigInt(options.reach ?? env.BSC_MAX_REACH);
  }

  /** A public node answers without a key, so this can always poll. */
  isConfigured(): boolean {
    return true;
  }

  credentials(): ProviderCredentials {
    return this.keyed ? 'KEYED' : 'ANONYMOUS';
  }

  validateAddress(address: string): boolean {
    return ADDRESS_PATTERN.test(address);
  }

  explorerUrl(txHash: string): string {
    return `https://bscscan.com/tx/${txHash}`;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw errors.external(`BSC node responded ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: { message?: string } };
      if (body.error) throw errors.external(`BSC node: ${body.error.message ?? 'error'}`);
      return body.result as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw errors.external('BSC node request timed out');
      }
      throw errors.external('BSC node', error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async currentBlock(): Promise<bigint | null> {
    try {
      return BigInt(await this.call<string>('eth_blockNumber', []));
    } catch (error) {
      log.warn('Could not read current BSC block height', { error });
      return null;
    }
  }

  async fetchBalance(address: string, contractAddress?: string | null): Promise<bigint> {
    if (!this.validateAddress(address)) {
      throw errors.validation([{ path: 'address', message: 'Not a valid BSC address' }]);
    }
    // balanceOf(address)
    const data = `0x70a08231${pad(address).slice(2)}`;
    const raw = await this.call<string>('eth_call', [
      { to: contractAddress ?? this.contract, data },
      'latest',
    ]);
    return fromTokenUnits(BigInt(raw && raw !== '0x' ? raw : '0x0'), USDT_BEP20_DECIMALS);
  }

  async fetchTransfers(
    address: string,
    contractAddress: string | null,
    options: FetchOptions = {},
  ): Promise<TransferPage> {
    if (!this.validateAddress(address)) {
      throw errors.validation([{ path: 'address', message: 'Not a valid BSC address' }]);
    }

    const head = BigInt(await this.call<string>('eth_blockNumber', []));
    const cursor = options.cursor && /^\d+$/.test(options.cursor) ? BigInt(options.cursor) : null;

    let from =
      cursor !== null
        ? cursor > REREAD_BLOCKS
          ? cursor - REREAD_BLOCKS
          : 0n
        : options.sinceBlock ?? (head > FIRST_LOOKBACK ? head - FIRST_LOOKBACK : 0n);
    if (from > head) from = head;
    const oldest = head > this.reach ? head - this.reach : 0n;
    if (from < oldest) {
      log.warn('BSC poll is further behind than the node can answer for; starting at its edge', {
        address: `${address.slice(0, 6)}…${address.slice(-4)}`,
        skippedBlocks: String(oldest - from),
      });
      from = oldest;
    }

    const logs: RpcLog[] = [];
    let scannedTo = from - 1n;
    for (let ranges = 0; ranges < MAX_RANGES && scannedTo < head; ranges++) {
      const start = scannedTo + 1n;
      const end = start + this.range - 1n > head ? head : start + this.range - 1n;
      const batch = await this.call<RpcLog[]>('eth_getLogs', [
        {
          fromBlock: hex(start),
          toBlock: hex(end),
          address: contractAddress ?? this.contract,
          topics: [TRANSFER_TOPIC, null, pad(address)],
        },
      ]);
      logs.push(...(batch ?? []).filter((entry) => !entry.removed));
      scannedTo = end;
    }

    // One header per block that carried a transfer, for its time.
    const times = new Map<string, Date>();
    for (const blockNumber of new Set(logs.map((entry) => entry.blockNumber))) {
      try {
        const block = await this.call<RpcBlock>('eth_getBlockByNumber', [blockNumber, false]);
        times.set(blockNumber, new Date(Number(BigInt(block.timestamp)) * 1000));
      } catch {
        // the time is a nicety; the transfer stands without it
      }
    }

    const transfers: ChainTransfer[] = logs.map((entry) => {
      const blockNumber = BigInt(entry.blockNumber);
      return {
        txHash: entry.transactionHash,
        fromAddress: unpad(entry.topics[1] ?? '0x'),
        toAddress: unpad(entry.topics[2] ?? '0x'),
        amount: fromTokenUnits(BigInt(entry.data && entry.data !== '0x' ? entry.data : '0x0'), USDT_BEP20_DECIMALS),
        tokenSymbol: 'USDT',
        contractAddress: entry.address,
        blockNumber,
        blockTimestamp: times.get(entry.blockNumber) ?? null,
        confirmations: Number(head - blockNumber),
        status: 'CONFIRMED',
        networkFee: 0n,
      };
    });

    return {
      transfers,
      cursor: String(scannedTo + 1n),
      hasMore: scannedTo < head,
    };
  }
}
