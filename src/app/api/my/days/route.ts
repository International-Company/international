import { z } from 'zod';
import { route } from '@/core/http/route';
import * as activity from '@/modules/exchange/activity.service';

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
  /** Somebody else's days — honoured only for someone who sees everybody's work. */
  tellerId: z.string().optional(),
});

/**
 * A teller's days, newest first: what each came to on the machine, and what he
 * still owed the bank when it ended.
 *
 * His own by default. A manager may name a teller; anyone else naming one gets
 * their own days, because the service decides whose, not this route.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.transaction.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    const days = await activity.dailyLedger(
      { days: query.days, tellerId: query.tellerId || null },
      actor,
    );
    const amounts = (list: activity.Amount[]) =>
      list.map((entry) => ({ currency: entry.currency, amount: entry.amount.toString() }));

    return {
      days: days.map((day) => ({
        ...day,
        received: amounts(day.received),
        paidCash: amounts(day.paidCash),
        paidBank: amounts(day.paidBank),
        owedAtEnd: amounts(day.owedAtEnd),
      })),
    };
  },
});
