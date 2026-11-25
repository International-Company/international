import { z } from 'zod';
import { route } from '@/core/http/route';
import { inquire } from '@/modules/bank/group-feed.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** A forwarded transfer asked after: the bot answers its copy "is it done?" and marks it ❓. */
export const POST = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  handler: async ({ params, actor }) => inquire(params.id, actor),
});
