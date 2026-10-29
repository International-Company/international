import { convert } from '@/core/money/money';

/**
 * A customer who pays both ways: part by transfer into one of the office's
 * accounts, the rest in notes across the counter.
 *
 * Shared by the machine screen and the server so the figure read out to the
 * customer is the figure posted. Each part is priced at its own channel — the
 * transfer at the bank rate, as a deal paid wholly by transfer is, the notes at
 * the till's — and the customer takes the sum in cash.
 */

/**
 * The two shares of what the customer hands over, or null when the transfer
 * is not a part of it. All or nothing is not "both ways": a full transfer is
 * the transfer option, and none is a cash deal.
 */
export function intakeShares(
  total: bigint,
  transferred: bigint,
): { cash: bigint; broker: bigint } | null {
  if (transferred <= 0n || transferred >= total) return null;
  return { cash: total - transferred, broker: transferred };
}

/** What the customer takes away: each share at its own price, added once rounded. */
export function paidBothWaysPayout(
  shares: { cash: bigint; broker: bigint },
  rates: { cash: bigint; broker: bigint },
  decimals: number,
): bigint {
  return (
    convert(shares.cash, rates.cash, decimals) + convert(shares.broker, rates.broker, decimals)
  );
}
