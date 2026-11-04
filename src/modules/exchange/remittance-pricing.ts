import { divideRounded, MONEY_FACTOR, roundToDecimals } from '@/core/money/money';

/**
 * A destination's price list, and what it makes of a sum.
 *
 * Each destination and currency has two fees on top of the sum being sent: what
 * the office charges the customer, and what the correspondent charges the
 * office. Either can be a flat amount or a percentage, since correspondents
 * price both ways. Shared by the screen and its tests; the figures it produces
 * are only a starting point, because the teller can still change them and the
 * server records what it is given.
 */

export const FEE_KINDS = ['FLAT', 'PERCENT'] as const;
export type FeeKind = (typeof FEE_KINDS)[number];

export interface Fee {
  kind: FeeKind;
  /** An amount, or a percentage, on the 1e8 scale. */
  value: bigint;
}

const HUNDRED = 100n * MONEY_FACTOR;

export function feeOn(amount: bigint, fee: Fee, decimals: number): bigint {
  if (fee.kind === 'FLAT') return fee.value;
  return roundToDecimals(divideRounded(amount * fee.value, HUNDRED), decimals);
}

/** What a sum comes to: the customer's total, and what the correspondent is owed. */
export function priceRemittance(
  amount: bigint,
  price: { charge: Fee; cost: Fee },
  decimals: number,
): { collected: bigint; cost: bigint; margin: bigint } {
  const charge = feeOn(amount, price.charge, decimals);
  const cost = feeOn(amount, price.cost, decimals);
  return { collected: amount + charge, cost: amount + cost, margin: charge - cost };
}

/** Whether a fee can be used: nothing negative, and a percentage short of everything. */
export function validFee(fee: Fee): boolean {
  if (fee.value < 0n) return false;
  return fee.kind === 'FLAT' || fee.value < HUNDRED;
}
