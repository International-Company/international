import { divideRounded, MONEY_FACTOR, roundToDecimals, toDecimalString } from '@/core/money/money';

/**
 * USDT taken in for dollars, at a percentage rather than a price.
 *
 * The office thinks of this pair differently from the others: a coin is a
 * dollar, less a cut. So 1000 USDT at 1% pays 990 dollars, and there is no rate
 * on the board to read. Shared by the counter's screen and the server, so the
 * figure read out is the figure posted.
 */

const HUNDRED = 100n * MONEY_FACTOR;

/** The one pair priced this way. */
export function isPercentPair(token: string, payoutCurrency: string): boolean {
  return token.toUpperCase() === 'USDT' && payoutCurrency.toUpperCase() === 'USD';
}

/** A cut the office can actually take: nothing at all, up to just short of everything. */
export function validPercent(percent: bigint): boolean {
  return percent >= 0n && percent < HUNDRED;
}

/** What `coins` pays at `percent`, both on the 1e8 scale, to the currency's precision. */
export function payoutAtPercent(coins: bigint, percent: bigint, decimals: number): bigint {
  return roundToDecimals(divideRounded(coins * (HUNDRED - percent), HUNDRED), decimals);
}

/** 1.5 rather than 1.50000000, for the line kept with the deal. */
export function percentText(percent: bigint): string {
  return toDecimalString(percent, 8).replace(/\.?0+$/, '');
}
