/**
 * A network as the customer's app names it.
 *
 * Binance, Trust Wallet and the rest ask "TRC20, ERC20 or BEP20?", not "TRON,
 * Ethereum or BSC?". Saying it their way at the counter is what keeps coins
 * from being sent on the wrong chain — which nobody can undo.
 */
const LABELS: Record<string, string> = {
  TRON: 'TRC20 (TRON)',
  ETHEREUM: 'ERC20 (Ethereum)',
  BSC: 'BEP20 (BSC)',
  // Not a chain: a transfer inside Binance, to the office's Binance ID.
  BINANCE: 'Binance Pay',
};

export function networkLabel(network: string): string {
  return LABELS[network] ?? network;
}
