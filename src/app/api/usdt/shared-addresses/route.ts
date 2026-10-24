import { z } from 'zod';
import { route } from '@/core/http/route';
import * as counter from '@/modules/usdt/counter.service';

const bodySchema = z.object({
  network: z.string().min(1).max(32),
  address: z.string().min(10).max(128),
});

/**
 * "Not this customer": marks a sending address as shared, so the counter stops
 * filling in whoever was first seen on it.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['usdt.counter.use'],
  bodySchema,
  handler: async ({ body, actor }) => counter.markAddressShared(body, actor),
});
