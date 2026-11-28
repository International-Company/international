import { z } from 'zod';
import { route } from '@/core/http/route';
import { unassign } from '@/modules/treasury/ewallet.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** Taken back from the wallet before it was sent. */
export const DELETE = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm', 'treasury.handover.manage'],
  paramsSchema,
  handler: async ({ params, actor }) => unassign(params.id, actor),
});
