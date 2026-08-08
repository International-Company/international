import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as drawers from '@/modules/drawers/drawer.service';

export const GET = route({
  permissions: ['exchange.drawer.view'],
  handler: async () => {
    const [rows, check] = await Promise.all([drawers.listDrawers(), drawers.verifyBalances()]);
    const derived = new Map(check.drawers.map((entry) => [entry.currency, entry]));

    return rows.map((drawer) => ({
      ...drawer,
      // Surfaced rather than logged quietly: a drawer that disagrees with its
      // own movements is the one thing here nobody should have to go looking for.
      agrees: derived.get(drawer.currencyCode)?.agrees ?? true,
    }));
  },
});

const bodySchema = z.object({
  currency: z.string().min(2).max(8),
  direction: z.enum(['IN', 'OUT']),
  amount: z.string(),
  note: z.string().max(500).optional(),
});

/**
 * Putting money in a drawer, or taking it out.
 *
 * The only way money enters or leaves the branch without a customer on the other
 * side of it, which is why it needs its own permission and its own audit line
 * rather than being one more kind of transaction.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.drawer.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const balance = await drawers.fund(
      {
        currency: body.currency.toUpperCase(),
        direction: body.direction,
        amount: parseMoney(body.amount),
        note: body.note ?? null,
      },
      actor,
    );

    return { currency: body.currency.toUpperCase(), balance };
  },
});
