import { route } from '@/core/http/route';
import { prisma } from '@/core/db/prisma';
import { dayKey } from '@/modules/exchange/business-day.service';

/**
 * Whether the counter is open, for the strip under the brand.
 *
 * Signed in is enough, deliberately. A teller does not hold `exchange.day.view`
 * and should not — the day panel is a manager's screen — but when his machine
 * refuses a trade with "no business day is open", the answer has to be
 * somewhere he can see it. This is that, and nothing else: a boolean and a
 * date, which is less than the refusal already tells him.
 */
export const GET = route({
  handler: async ({ actor }) => {
    if (!actor.branchId) return { open: false, date: null, canOpen: false };

    /*
     * Today's row specifically, not "any open day". A posting is keyed to the
     * calendar date it happens on, so a day left open from yesterday does not
     * let anybody record anything — and a strip that called that "open" would
     * be contradicting the refusal it exists to explain.
     */
    const today = await prisma.businessDay.findUnique({
      where: { branchId_date: { branchId: actor.branchId, date: dayKey(new Date()) } },
      select: { date: true, status: true },
    });

    return {
      open: today?.status === 'OPEN' || today?.status === 'REOPENED',
      date: today?.date ?? null,
      canOpen: actor.permissions.includes('exchange.day.open'),
    };
  },
});
