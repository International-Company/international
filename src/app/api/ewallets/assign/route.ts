import { z } from 'zod';
import { route } from '@/core/http/route';
import { assign } from '@/modules/treasury/ewallet.service';

const bodySchema = z.object({
  kind: z.enum(['deal', 'request', 'tiktok']),
  refId: z.string().min(1),
  drawerId: z.string().min(1),
});

/** A transfer on the bank desk handed to a teller's wallet to send. */
export const POST = route<z.infer<typeof bodySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm', 'treasury.handover.manage'],
  bodySchema,
  handler: async ({ body, actor }) => assign(body.kind, body.refId, body.drawerId, actor),
});
