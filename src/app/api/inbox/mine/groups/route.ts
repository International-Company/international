import { z } from 'zod';
import { route } from '@/core/http/route';
import { followGroup, numberGroups } from '@/modules/whatsapp/teller-whatsapp.service';

/** Every group the teller's own number is in, and which of them the teller follows. */
export const GET = route({
  permissions: ['customers.whatsapp'],
  handler: async ({ actor }) => numberGroups(actor.id),
});

const bodySchema = z.object({
  chat: z.string().trim().min(5).max(80),
  follow: z.boolean(),
});

/** Follows one of the number's groups from the inbox, or stops following it. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema,
  handler: async ({ body, actor }) => followGroup(actor.id, body.chat, body.follow),
});
