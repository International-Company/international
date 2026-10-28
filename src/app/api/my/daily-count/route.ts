import { z } from 'zod';
import { route } from '@/core/http/route';
import * as daily from '@/modules/exchange/daily-count.service';

const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

/**
 * The teller's day, by kind: USDT received, USDT sent, bought, sold. No
 * teller parameter — it is always the caller's own.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.transaction.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    const result = await daily.dailyCount(
      { from: new Date(query.from), to: new Date(query.to) },
      actor,
    );
    const amounts = (list: daily.CountAmount[]) =>
      list.map((entry) => ({ currency: entry.currency, amount: entry.amount.toString() }));

    return {
      from: result.from.toISOString(),
      to: result.to.toISOString(),
      groups: result.groups.map((group) => ({
        kind: group.kind,
        count: group.count,
        received: amounts(group.received),
        paid: amounts(group.paid),
        entries: group.entries.map((entry) => ({
          ...entry,
          at: entry.at.toISOString(),
          fromAmount: entry.fromAmount.toString(),
          toAmount: entry.toAmount.toString(),
          payoutBank: entry.payoutBank.toString(),
        })),
      })),
    };
  },
});
