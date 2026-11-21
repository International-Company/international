import { z } from 'zod';
import { route } from '@/core/http/route';
import { unforward } from '@/modules/bank/group-feed.service';

const paramsSchema = z.object({ id: z.string().min(1) });

const bodySchema = z.object({
  /** Also delete, for everyone, the copies the office's number wrote to those groups. */
  deleteCopies: z.boolean().default(true),
});

/** A transfer's forward taken back: it waits again. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => unforward(params.id, body.deleteCopies, actor),
});
