import { z } from 'zod';
import { route } from '@/core/http/route';
import * as counter from '@/modules/usdt/counter.service';

const querySchema = z.object({
  /** Skip the chain and read only what is stored — for a quiet background poll. */
  sync: z.enum(['true', 'false']).optional(),
});

/**
 * Money on a counter address that nobody has claimed.
 *
 * The chain is asked first by default, because the teller opening this is
 * usually doing it because a customer has just said "I sent it". A provider
 * having a bad minute does not empty the tray — it falls through to what is
 * already stored.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['usdt.counter.use'],
  querySchema,
  handler: async ({ query }) => {
    const arrivals = await counter.unclaimedArrivals({ sync: query.sync !== 'false' });
    return arrivals.map((arrival) => ({
      ...arrival,
      amount: arrival.amount.toString(),
      firstSeenAt: arrival.firstSeenAt.toISOString(),
    }));
  },
});
