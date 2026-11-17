import { z } from 'zod';
import { route } from '@/core/http/route';
import { forwardByHand } from '@/modules/bank/group-feed.service';

const paramsSchema = z.object({ id: z.string().min(1) });

const bodySchema = z.object({
  targets: z
    .array(z.object({ id: z.string().min(5).max(80), name: z.string().max(120) }))
    .min(1)
    .max(10),
  /** The words as the person left them; the photo goes with them when there is one. */
  text: z.string().max(4000).default(''),
});

/** A followed group's message, passed on by the bot to the groups chosen. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => forwardByHand(params.id, body, actor),
});
