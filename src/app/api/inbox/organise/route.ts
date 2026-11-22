import { z } from 'zod';
import { route } from '@/core/http/route';
import { markChat, organisation } from '@/modules/whatsapp/inbox-organise.service';

const scope = z.enum(['bot', 'teller']);

/** This person's labels, and how they keep each conversation of one inbox. */
export const GET = route<unknown, { scope: z.infer<typeof scope> }>({
  permissions: ['customers.whatsapp'],
  querySchema: z.object({ scope }),
  handler: async ({ query, actor }) => organisation(actor.id, query.scope),
});

const bodySchema = z.object({
  scope,
  chatId: z.string().min(1).max(40),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  markedUnread: z.boolean().optional(),
  labels: z.array(z.string().min(1).max(40)).max(30).optional(),
});

export const PUT = route<z.infer<typeof bodySchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const { scope: inbox, chatId, ...change } = body;
    return markChat(actor.id, inbox, chatId, change);
  },
});
