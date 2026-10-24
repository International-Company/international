import { z } from 'zod';
import { route } from '@/core/http/route';
import * as activity from '@/modules/exchange/activity.service';

const paramsSchema = z.object({ id: z.string().min(1) });
const querySchema = z.object({
  /** Somebody else's day — honoured only for someone who sees everybody's work. */
  tellerId: z.string().optional(),
});

/**
 * The exchanges behind one of a teller's days, oldest first — what opens when
 * a day is tapped in "Work days".
 *
 * His own by default; the service, not this route, decides whose.
 */
export const GET = route<unknown, z.infer<typeof querySchema>, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.transaction.view'],
  paramsSchema,
  querySchema,
  handler: async ({ params, query, actor }) => ({
    entries: await activity.dayEntries(
      { dayId: params.id, tellerId: query.tellerId || null },
      actor,
    ),
  }),
});
