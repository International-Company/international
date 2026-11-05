/**
 * The USDT a sum received buys at a price, to two places and rounded down: the
 * office never promises a fraction more than was paid for. Here so the screen
 * shows the same figure the server keeps.
 */
export function saleCoins(received: bigint, price: bigint): bigint {
  if (received <= 0n || price <= 0n) return 0n;
  return ((received * 100_000_000n) / price / 1_000_000n) * 1_000_000n;
}
