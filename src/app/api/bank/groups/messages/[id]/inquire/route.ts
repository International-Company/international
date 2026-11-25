import { z } from 'zod';
import { route } from '@/core/http/route';
import { inquire } from '@/modules/bank/group-feed.service';

const paramsSchema = z.object({ id: z.string().min(1) });

const bodySchema = z.object({
  /** What to ask, in the person's own words; none, "is it done?". */
  text: z.string().max(1000).optional(),
});

/** A forwarded transfer asked after: the bot answers its copy with the words given and marks it ❓. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => inquire(params.id, actor, body.text ?? null),
});
