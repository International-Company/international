import { z } from 'zod';
import { route } from '@/core/http/route';
import { cancelledLog } from '@/modules/bank/bank.service';

const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** What was cancelled on the desk in the days asked for, and by whom. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  querySchema,
  handler: async ({ actor, query }) =>
    cancelledLog(actor, {
      from: new Date(query.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString()),
      to: new Date(query.to ?? new Date().toISOString()),
    }),
});
