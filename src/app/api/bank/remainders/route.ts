import { z } from 'zod';
import { route } from '@/core/http/route';
import { remainders } from '@/modules/bank/bank.service';

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** What is left of the transfers of the days asked for — the last fortnight by default. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  querySchema,
  handler: async ({ actor, query }) =>
    remainders(actor, {
      from: new Date(query.from ?? new Date(Date.now() - 14 * 86_400_000).toISOString()),
      to: new Date(query.to ?? new Date().toISOString()),
    }),
});
