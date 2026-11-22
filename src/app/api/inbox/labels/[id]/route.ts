import { z } from 'zod';
import { route } from '@/core/http/route';
import { organisation, removeLabel } from '@/modules/whatsapp/inbox-organise.service';

const paramsSchema = z.object({ id: z.string().min(1) });
const querySchema = z.object({ scope: z.enum(['bot', 'teller']) });

export const DELETE = route<unknown, z.infer<typeof querySchema>, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  querySchema,
  handler: async ({ params, query, actor }) => {
    await removeLabel(actor.id, params.id);
    return organisation(actor.id, query.scope);
  },
});
