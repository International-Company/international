/**
 * Why money was put into or taken out of a drawer by hand.
 *
 * The daily result cannot be measured without this. What the branch is worth
 * changes for two quite different reasons — it traded, or its owner moved money
 * across the boundary — and only the first is profit. An owner's withdrawal
 * looks exactly like a loss to any arithmetic that cannot tell them apart.
 *
 * `TRANSFER` moves money between the branch's own balances and changes its
 * worth by nothing; it is named so the day reads honestly rather than because
 * the result needs it. `CORRECTION` is a counting difference, which *is* a real
 * gain or loss and stays in the result — it is separated only so a manager can
 * see how much of the day came from miscounting rather than from trading.
 *
 * Free of server-only imports: the screen that records a funding movement has
 * to offer these, and the service that measures the day has to read them. One
 * definition, both sides.
 */

export const FUNDING_CATEGORIES = [
  'OWNER_IN',
  'OWNER_OUT',
  'EXPENSE',
  'TRANSFER',
  'CORRECTION',
] as const;

export type FundingCategory = (typeof FUNDING_CATEGORIES)[number];

export function isFundingCategory(value: string): value is FundingCategory {
  return (FUNDING_CATEGORIES as readonly string[]).includes(value);
}
