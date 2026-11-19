import { z } from 'zod';
import { route } from '@/core/http/route';
import { track } from '@/modules/bank/track.service';

/** The days asked for, as the browser's own midnight to midnight; none, today. */
const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/** Every transfer of the days asked for, followed from where it began to where it was carried out. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  querySchema,
  handler: async ({ actor, query }) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return track(actor, {
      from: query.from ? new Date(query.from) : today,
      to: query.to ? new Date(query.to) : new Date(),
    });
  },
});
