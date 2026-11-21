import { z } from 'zod';
import { route } from '@/core/http/route';
import { listConversations } from '@/modules/whatsapp/bot-store';
import { listChats } from '@/modules/whatsapp/teller-whatsapp.service';

/** A person's number, or `private` for the private number. */
const paramsSchema = z.object({ owner: z.string().min(1) });

/** The conversations on one number, for the manager watching it. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp.monitor'],
  paramsSchema,
  handler: async ({ params }) =>
    params.owner === 'private' ? listConversations() : listChats(params.owner),
});
