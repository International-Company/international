import { z } from 'zod';
import { route } from '@/core/http/route';
import { trace } from '@/modules/bank/group-feed.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** A message's way through the groups: where it began, where it went, what became of it. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  handler: async ({ params, actor }) => trace(params.id, actor),
});
