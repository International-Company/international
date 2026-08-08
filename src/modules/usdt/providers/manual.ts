import 'server-only';
import type { ChainProvider, ProviderCredentials, TransferPage } from './types';

/**
 * Manual provider — the default.
 *
 * It never contacts an external service. Wallets stay under full operator
 * control: balances and transfers are whatever staff have recorded through the
 * UI. This makes the module immediately usable with no API keys, keeps the
 * system working when an explorer is down or rate-limited, and gives an office
 * that prefers not to expose its wallet addresses to a third party a supported
 * way to run.
 *
 * Recorded transfers are still reconciled, notified and posted exactly like
 * automatically discovered ones.
 */
export class ManualProvider implements ChainProvider {
  readonly network = 'MANUAL' as const;
  readonly name = 'Manual entry';

  isConfigured(): boolean {
    return true;
  }

  credentials(): ProviderCredentials {
    return 'NOT_REQUIRED';
  }

  /** Any non-empty address is accepted; the operator vouches for it. */
  validateAddress(address: string): boolean {
    return address.trim().length >= 8;
  }

  explorerUrl(txHash: string): string {
    return `https://tronscan.org/#/transaction/${txHash}`;
  }

  /** Balance is whatever the ledger already records — never overwritten. */
  async fetchBalance(): Promise<bigint> {
    return 0n;
  }

  async currentBlock(): Promise<bigint | null> {
    return null;
  }

  async fetchTransfers(): Promise<TransferPage> {
    return { transfers: [], cursor: null, hasMore: false };
  }
}
