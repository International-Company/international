import { z } from 'zod';
import { route } from '@/core/http/route';
import { organisation, saveLabel } from '@/modules/whatsapp/inbox-organise.service';

const bodySchema = z.object({
  scope: z.enum(['bot', 'teller']),
  id: z.string().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(30),
  color: z.string().max(10),
});

/** A label made or renamed; the inbox's organisation comes back with it. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema,
  handler: async ({ body, actor }) => {
    await saveLabel(actor.id, body);
    return organisation(actor.id, body.scope);
  },
});
