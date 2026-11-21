import { z } from 'zod';
import { route } from '@/core/http/route';
import { desk } from '@/modules/bank/bank.service';

/** The days asked for, as the browser's own midnight to midnight: both ends or neither. */
const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** Looked for in every day, whatever days are asked for. */
  q: z.string().trim().max(80).optional(),
});

/** The bank desk: what is still to be sent, what was sent today, and every transfer of the days asked for. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  querySchema,
  handler: async ({ actor, query }) =>
    desk(
      actor,
      undefined,
      query.from || query.to
        ? {
            from: new Date(query.from ?? '2000-01-01T00:00:00.000Z'),
            to: new Date(query.to ?? new Date().toISOString()),
          }
        : null,
      query.q || null,
    ),
});
