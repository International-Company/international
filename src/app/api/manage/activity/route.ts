import { z } from 'zod';
import { route } from '@/core/http/route';
import * as activity from '@/modules/exchange/activity.service';

const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  tellerId: z.string().optional(),
});

/**
 * What each person at the counter did in a window, by kind of work.
 *
 * Amounts leave as strings: they are 1e8-scaled bigints, and JSON would round
 * them through a float on the way.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.transaction.viewAll'],
  querySchema,
  handler: async ({ query, actor }) => {
    const result = await activity.activity(
      {
        from: new Date(query.from),
        to: new Date(query.to),
        tellerId: query.tellerId || null,
      },
      actor,
    );

    const amounts = (list: activity.Amount[] | null) =>
      list?.map((entry) => ({
        currency: entry.currency,
        amount: entry.amount.toString(),
      })) ?? null;

    return {
      ...result,
      tellers: result.tellers.map((teller) => ({
        ...teller,
        lastAt: teller.lastAt?.toISOString() ?? null,
      })),
      types: result.types.map((totals) => ({
        ...totals,
        received: amounts(totals.received),
        paid: amounts(totals.paid),
        margin: amounts(totals.margin),
      })),
    };
  },
});
