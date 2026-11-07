/**
 * The USDT a sum received buys at a price, to two places and rounded down: the
 * office never promises a fraction more than was paid for. Here so the screen
 * shows the same figure the server keeps.
 */
export function saleCoins(received: bigint, price: bigint): bigint {
  if (received <= 0n || price <= 0n) return 0n;
  return ((received * 100_000_000n) / price / 1_000_000n) * 1_000_000n;
}

/** Dollars are sold for coins by a percentage; every other currency by a price. */
export const PERCENT_CURRENCY = 'USD';

/*
 * A sale paid in dollars is priced by a percentage the office keeps, not a price:
 * the customer gets what they paid less that share, one coin a dollar. The
 * percentage is scaled like money, so 3% is 3_00000000n.
 */
const HUNDRED = 100n * 100_000_000n;

/** Whether a percentage can price a sale: at least nothing, short of all of it. */
export function validPercent(percent: bigint): boolean {
  return percent >= 0n && percent < HUNDRED;
}

/** The coins dollars received buy, the percentage kept: two places, rounded down. */
export function percentCoins(received: bigint, percent: bigint): bigint {
  if (received <= 0n || !validPercent(percent)) return 0n;
  return ((received * (HUNDRED - percent)) / HUNDRED / 1_000_000n) * 1_000_000n;
}

/** The dollars a number of coins costs, the percentage kept, half-up at `decimals`. */
export function percentTotal(coins: bigint, percent: bigint, decimals: number): bigint {
  if (coins <= 0n || !validPercent(percent)) return 0n;
  const step = 10n ** BigInt(Math.max(0, 8 - decimals));
  const denominator = (HUNDRED - percent) * step;
  return ((coins * HUNDRED * 2n + denominator) / (2n * denominator)) * step;
}

/** The deal's rate, coins per dollar, for a percentage: 3% reads 0.97. */
export function percentRate(percent: bigint): bigint {
  return (HUNDRED - percent) / 100n;
}

/** The percentage a dollar sale's rate says, back again: 0.97 reads 3%. */
export function percentOfRate(rate: bigint): bigint {
  return HUNDRED - rate * 100n;
}
