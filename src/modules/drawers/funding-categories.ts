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

/**
 * Where the money is.
 *
 * Beside the funding categories for the same reason they are here: a client
 * component cannot import the drawer service, and both the screens and the
 * server have to agree on this list.
 */
export const DRAWER_KINDS = [
  'CASH',
  'BROKER',
  'CORRESPONDENT',
  'DIFFERENCE',
  'RECEIVABLE',
  'IN_TRANSIT',
] as const;
export type DrawerKind = (typeof DRAWER_KINDS)[number];

/**
 * Money that has left one balance and not yet reached the next.
 *
 * A drawer rather than a flag on the transfer, for the reason every other
 * balance here is a drawer: the cash is genuinely somewhere between two places
 * for a day, and the only honest way to say so is to have somewhere for it to
 * be. Marking the source as "reserved" instead would leave a till whose balance
 * disagrees with the notes inside it.
 *
 * Nothing pays out of it. It is filled by a transfer leaving and emptied by the
 * same transfer arriving, and no other code has any business touching it.
 */
export const IN_TRANSIT: DrawerKind = 'IN_TRANSIT';

/**
 * The balances a transfer may move between.
 *
 * `DIFFERENCE` is excluded because it is not money: it is the trace of a
 * counting error, and it must stay visible in the day's result. Allowing a
 * transfer out of it would let a real shortage be renamed into nothing.
 * `RECEIVABLE` is excluded because moving it would settle a debt without the
 * debtor doing anything. `IN_TRANSIT` is excluded because it is the machinery,
 * not a destination anyone chooses.
 */
export const TRANSFERABLE_KINDS = ['CASH', 'BROKER', 'CORRESPONDENT'] as const;
export type TransferableKind = (typeof TRANSFERABLE_KINDS)[number];

export function isTransferable(kind: string): kind is TransferableKind {
  return (TRANSFERABLE_KINDS as readonly string[]).includes(kind);
}

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
