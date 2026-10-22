import { z } from 'zod';
import { route } from '@/core/http/route';
import * as recognition from '@/modules/usdt/recognition.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/**
 * Where a customer has been paid by transfer before, most used first — so the
 * counter can offer the account instead of asking for it again.
 *
 * Inside the counter permission: it is read only to settle a transfer the
 * teller is already looking at, and holds nothing the receipt does not.
 */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['usdt.counter.use'],
  paramsSchema,
  handler: async ({ params }) => ({ payouts: await recognition.payoutsFor(params.id) }),
});
