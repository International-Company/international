import { z } from 'zod';
import { route } from '@/core/http/route';
import { readConversation } from '@/modules/whatsapp/bot-store';
import { readChat } from '@/modules/whatsapp/teller-whatsapp.service';

const paramsSchema = z.object({ owner: z.string().min(1), id: z.string().min(1) });

/**
 * One conversation, read by the manager watching. Not marked read: what came in
 * is still unread for whoever answers on that number.
 */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp.monitor'],
  paramsSchema,
  handler: async ({ params }) =>
    params.owner === 'private'
      ? readConversation(params.id)
      : readChat(params.owner, params.id, { watching: true }),
});
