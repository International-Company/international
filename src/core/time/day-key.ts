/**
 * The calendar day, as this system keys it.
 *
 * Pure date arithmetic with no database and no module of its own to belong to.
 * It lives here because both the business day and the ledger need it, and
 * having the ledger reach into the business day for it — while the business day
 * calls the ledger to freeze its position — would be a circle drawn for no
 * better reason than where two functions happened to be written first.
 */

/** Normalises any timestamp to local midnight — the day's canonical key. */
export function dayKey(date: Date): Date {
  const key = new Date(date);
  key.setHours(0, 0, 0, 0);
  return key;
}

/**
 * Renders a day as `YYYY-MM-DD` from its **local** calendar fields.
 *
 * `toISOString()` cannot be used here: a day key is local midnight, and in any
 * timezone ahead of UTC that instant belongs to the previous UTC date — so the
 * branch that opened on the 6th would be labelled the 5th in its own audit log.
 */
export function formatDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dayBounds(date: Date): { start: Date; end: Date } {
  const start = dayKey(date);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}
