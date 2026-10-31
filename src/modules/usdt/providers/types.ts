import { MONEY_SCALE } from '@/core/money/money';

/**
 * Blockchain provider abstraction.
 *
 * Monitoring is defined against this interface rather than against any one
 * explorer API, so a desk can run TRON today, add Ethereum tomorrow, and switch
 * data source when an API changes its terms — without any change to the wallet
 * service, the reconciliation logic or the UI.
 */

export type Network = 'TRON' | 'ETHEREUM' | 'BSC' | 'BINANCE' | 'MANUAL';

export interface ChainTransfer {
  txHash: string;
  fromAddress: string;
  toAddress: string;
  /** Already normalised to the system's 1e8 scale. */
  amount: bigint;
  tokenSymbol: string;
  contractAddress: string | null;
  blockNumber: bigint | null;
  blockTimestamp: Date | null;
  confirmations: number;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  networkFee: bigint;
  /** What the provider knows that an address does not say — a Binance payer's name. */
  memo?: string | null;
}

export interface TransferPage {
  transfers: ChainTransfer[];
  /** Opaque continuation token stored on the wallet for the next poll. */
  cursor: string | null;
  hasMore: boolean;
}

export interface FetchOptions {
  cursor?: string | null;
  limit?: number;
  /** Only return transfers at or after this block. */
  sinceBlock?: bigint | null;
}

/**
 * Which credentials a provider is currently reaching the network with.
 *
 * `isConfigured()` answers "can this poll at all", which is not the same
 * question as "is it using the key you paid for". TronGrid answers anonymous
 * requests at a low rate, so a desk whose key never reached the server looks
 * identical to one whose key is working — until the day the volume matters.
 * This reports the difference so the screen can state it.
 */
export type ProviderCredentials =
  /** The provider needs no credentials — manual entry. */
  | 'NOT_REQUIRED'
  /** Reaching the network with the configured key. */
  | 'KEYED'
  /** No key configured; using whatever the public tier allows. */
  | 'ANONYMOUS'
  /** A key was configured and the network refused it. */
  | 'REJECTED';

export interface ChainProvider {
  readonly network: Network;
  readonly name: string;
  /** False when the provider needs configuration it does not have. */
  isConfigured(): boolean;
  /** Which credentials the provider is currently using. */
  credentials(): ProviderCredentials;
  /** Token balance of an address, scaled to 1e8. */
  fetchBalance(address: string, contractAddress?: string | null): Promise<bigint>;
  fetchTransfers(
    address: string,
    contractAddress: string | null,
    options?: FetchOptions,
  ): Promise<TransferPage>;
  /** Latest block height, used to compute confirmations. */
  currentBlock(): Promise<bigint | null>;
  validateAddress(address: string): boolean;
  /** Link to a public explorer for a transaction — shown in the UI. */
  explorerUrl(txHash: string): string;
}

/**
 * Converts a raw on-chain integer to the system's 1e8 scale.
 * USDT uses 6 decimals on both TRON and Ethereum; native assets use 18. Scaling
 * with bigint throughout means no precision is lost on the way in.
 */
export function fromTokenUnits(raw: string | bigint, tokenDecimals: number): bigint {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw || '0');

  if (tokenDecimals === MONEY_SCALE) return value;
  if (tokenDecimals < MONEY_SCALE) {
    return value * 10n ** BigInt(MONEY_SCALE - tokenDecimals);
  }
  // More precision on chain than we store: truncate rather than round, so a
  // recorded balance is never higher than what the chain actually holds.
  return value / 10n ** BigInt(tokenDecimals - MONEY_SCALE);
}

export function toTokenUnits(scaled: bigint, tokenDecimals: number): bigint {
  if (tokenDecimals === MONEY_SCALE) return scaled;
  if (tokenDecimals < MONEY_SCALE) {
    return scaled / 10n ** BigInt(MONEY_SCALE - tokenDecimals);
  }
  return scaled * 10n ** BigInt(tokenDecimals - MONEY_SCALE);
}

export const USDT_DECIMALS = 6;
