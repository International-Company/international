import { z } from 'zod';
import { route } from '@/core/http/route';
import { removeReply } from '@/modules/whatsapp/inbox-organise.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const DELETE = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  handler: async ({ params, actor }) =>
    removeReply(actor.id, params.id, actor.permissions.includes('customers.whatsapp.monitor')),
});
