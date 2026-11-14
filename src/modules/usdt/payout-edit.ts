/**
 * A teller changing what a USDT receipt pays, before it is recorded and the bot
 * writes it to the group.
 *
 * It changes the deal, not only the message: the group pays what the message
 * says, so a message differing from the books would leave the broker's balance
 * wrong by the difference. And since a slip here pays out real money, it is held
 * to a limit around the computed figure: 990 mistyped as 9900 is refused rather
 * than transferred.
 */

export type PayoutEditRefusal = 'errors.payoutEditInvalid' | 'errors.payoutEditTooFar';

/** The payout currency a teller may name their own price in. */
export function tellerPriceAllowed(payoutCurrency: string): boolean {
  return payoutCurrency.toUpperCase() === 'ILS';
}

/** Whether a figure is close enough to the computed one. A limit of zero means no limit. */
export function withinEditLimit(computed: bigint, edited: bigint, limitPercent: number): boolean {
  if (limitPercent <= 0) return true;
  const gap = edited > computed ? edited - computed : computed - edited;
  // In hundredths of a percent, so a limit of 2.5 stays exact in integers.
  return gap * 10_000n <= computed * BigInt(Math.round(limitPercent * 100));
}

/**
 * The two legs once the total has been changed.
 *
 * Paid part each, the difference falls on the transfer: that is the figure the
 * bot writes, and the notes were counted out across the counter. A deal paid one
 * way simply takes the new total.
 */
export function applyPayoutEdit(
  legs: { cash: bigint; bank: bigint },
  edited: bigint,
  limitPercent: number,
): { cash: bigint; bank: bigint } | PayoutEditRefusal {
  const computed = legs.cash + legs.bank;
  if (edited <= 0n) return 'errors.payoutEditInvalid';
  if (!withinEditLimit(computed, edited, limitPercent)) return 'errors.payoutEditTooFar';

  if (legs.bank === 0n) return { cash: edited, bank: 0n };
  const bank = edited - legs.cash;
  if (bank <= 0n) return 'errors.payoutEditInvalid';
  return { cash: legs.cash, bank };
}

/**
 * Paid part each, with the teller giving each part its own figure: what goes by
 * transfer and what is counted out in notes. Each must stay a part, and the two
 * together are held to the same limit around the computed total.
 */
export function applySplitEdit(
  legs: { cash: bigint; bank: bigint },
  edited: { cash: bigint; bank: bigint },
  limitPercent: number,
): { cash: bigint; bank: bigint } | PayoutEditRefusal {
  if (edited.cash <= 0n || edited.bank <= 0n) return 'errors.payoutEditInvalid';
  if (!withinEditLimit(legs.cash + legs.bank, edited.cash + edited.bank, limitPercent)) {
    return 'errors.payoutEditTooFar';
  }
  return { cash: edited.cash, bank: edited.bank };
}
