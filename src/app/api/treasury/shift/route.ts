import { prisma } from '@/core/db/prisma';
import { route } from '@/core/http/route';
import * as drawers from '@/modules/drawers/drawer.service';
import * as shifts from '@/modules/treasury/shift.service';

/**
 * What the caller is holding, and since when.
 *
 * A teller pays customers out of their own drawer, so this is the figure they
 * work against all day and the figure they will be counted on tonight. It has to
 * be theirs alone — showing the office's balance here would tell them they can
 * hand over money that is not in front of them.
 *
 * No permission beyond being signed in: it returns only the caller's own
 * balances, and there is nobody a person should be kept from seeing that about.
 */
export const GET = route({
  handler: async ({ actor }) => {
    const [shift, held] = await Promise.all([
      shifts.current(actor.id),
      prisma.drawer.findMany({
        where: { ownerKey: drawers.tellerOwner(actor.id), isActive: true },
        orderBy: { sortOrder: 'asc' },
        include: { currency: { select: { decimals: true } } },
      }),
    ]);

    return {
      shift: shift && {
        reference: shift.reference,
        openedAt: shift.openedAt.toISOString(),
      },
      // Everything, including the zeroes: a drawer that has come back to zero is
      // the thing the teller is trying to prove, so hiding it would hide the
      // answer.
      holdings: held.map((row) => ({
        currency: row.currencyCode,
        kind: row.kind,
        decimals: row.currency.decimals,
        amount: row.balance.toString(),
      })),
    };
  },
});
