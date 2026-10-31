import 'server-only';
import { decryptSecret } from '@/core/security/crypto';
import { prisma, type DbClient } from '@/core/db/prisma';
import { BinanceProvider } from './binance';
import { BscProvider } from './bsc';
import { EthereumProvider } from './ethereum';
import { ManualProvider } from './manual';
import { TronProvider } from './tron';
import type { ChainProvider, Network, ProviderCredentials } from './types';

/**
 * Provider registry. Resolution is per wallet network, so one desk can monitor
 * TRON and Ethereum addresses side by side.
 */

const registry = new Map<Network, ChainProvider>([
  ['TRON', new TronProvider()],
  ['ETHEREUM', new EthereumProvider()],
  ['BSC', new BscProvider()],
  // Keyless: it stands for the network. A wallet is read through `providerForWallet`.
  ['BINANCE', new BinanceProvider()],
  ['MANUAL', new ManualProvider()],
]);

/**
 * Returns the provider for a network, falling back to manual when the network
 * is unknown or its provider lacks configuration. Falling back is deliberate:
 * an unconfigured Etherscan key should leave the wallet visible and manually
 * maintainable, not break the whole USDT screen.
 */
export function providerFor(network: string): ChainProvider {
  const provider = registry.get(network as Network);
  if (!provider) return registry.get('MANUAL')!;
  if (!provider.isConfigured()) return registry.get('MANUAL')!;
  return provider;
}

/** What the Binance keys are encrypted under; nothing else shares it. */
export const WALLET_KEY_PURPOSE = 'wallet-credentials';

/**
 * The provider that reads one wallet.
 *
 * The same as `providerFor` for a chain, whose access is the server's. A
 * Binance account is read with that wallet's own key, decrypted here and only
 * for as long as the read takes — it is never on the wallet row, so nothing
 * that loads a wallet can carry it to a screen.
 */
export async function providerForWallet(
  wallet: { id: string; network: string },
  db: DbClient = prisma,
): Promise<ChainProvider> {
  if (wallet.network !== 'BINANCE') return providerFor(wallet.network);
  const stored = await db.walletCredential.findUnique({ where: { walletId: wallet.id } });
  return new BinanceProvider(
    stored
      ? {
          apiKey: decryptSecret(stored.apiKey, WALLET_KEY_PURPOSE),
          apiSecret: decryptSecret(stored.apiSecret, WALLET_KEY_PURPOSE),
        }
      : null,
  );
}

/** The provider for a network regardless of configuration — used for validation. */
export function strictProviderFor(network: string): ChainProvider | null {
  return registry.get(network as Network) ?? null;
}

export function availableNetworks(): {
  network: Network;
  name: string;
  configured: boolean;
  credentials: ProviderCredentials;
}[] {
  return [...registry.values()].map((provider) => ({
    network: provider.network,
    name: provider.name,
    configured: provider.isConfigured(),
    credentials: provider.credentials(),
  }));
}

export * from './types';
export { TronProvider, EthereumProvider, BscProvider, BinanceProvider, ManualProvider };
