import 'server-only';
import { EthereumProvider } from './ethereum';
import { ManualProvider } from './manual';
import { TronProvider } from './tron';
import type { ChainProvider, Network } from './types';

/**
 * Provider registry. Resolution is per wallet network, so one desk can monitor
 * TRON and Ethereum addresses side by side.
 */

const registry = new Map<Network, ChainProvider>([
  ['TRON', new TronProvider()],
  ['ETHEREUM', new EthereumProvider()],
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

/** The provider for a network regardless of configuration — used for validation. */
export function strictProviderFor(network: string): ChainProvider | null {
  return registry.get(network as Network) ?? null;
}

export function availableNetworks(): {
  network: Network;
  name: string;
  configured: boolean;
}[] {
  return [...registry.values()].map((provider) => ({
    network: provider.network,
    name: provider.name,
    configured: provider.isConfigured(),
  }));
}

export * from './types';
export { TronProvider, EthereumProvider, ManualProvider };
