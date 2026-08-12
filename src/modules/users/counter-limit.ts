import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';

/**
 * How far one person is trusted at the counter.
 *
 * The office sets a ceiling for the window; a manager may set a lower one for a
 * named person — a teller in his first month, or one who has cost the office
 * money. The two are not alternatives: whichever is stricter applies, so
 * tightening the office ceiling can never loosen anybody's, and raising a
 * person's can never lift them over the office's.
 *
 * Zero and null both mean "no ceiling of my own" on either side, which is how
 * the office settings already read, so the two are never in different languages.
 *
 * A ceiling is deliberately not a permission. A permission answers whether a
 * person may work the counter at all; this answers how far. Saying "up to five
 * thousand" with permissions would mean one permission per amount.
 */
export async function ceilingFor(
  userId: string,
  officeLimit: bigint,
  db: DbClient = prisma,
): Promise<bigint> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { counterLimit: true },
  });
  const own = row?.counterLimit ?? 0n;

  if (own <= 0n) return officeLimit;
  if (officeLimit <= 0n) return own;
  return own < officeLimit ? own : officeLimit;
}
