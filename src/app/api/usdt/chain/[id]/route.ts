import { z } from 'zod';
import { route } from '@/core/http/route';
import { toJsonSafe } from '@/core/http/json';
import { chainDetail } from '@/modules/usdt/sync.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** One transfer on the chain, as an explorer shows it, with its confirmations read live. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['usdt.counter.use', 'usdt.transaction.view'],
  paramsSchema,
  handler: async ({ params }) => toJsonSafe(await chainDetail(params.id)),
});
