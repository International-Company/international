import { z } from 'zod';
import { route } from '@/core/http/route';
import { listConversations } from '@/modules/whatsapp/bot-store';
import { MAX_ANSWER_LENGTH, startConversation } from '@/modules/whatsapp/inbox.service';

export const GET = route({
  permissions: ['customers.whatsapp'],
  handler: async () => listConversations(),
});

const bodySchema = z.object({
  phone: z.string().trim().min(5).max(30),
  text: z.string().trim().min(1).max(MAX_ANSWER_LENGTH),
});

/** A new conversation, written first by the office to a number. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema,
  handler: async ({ body, actor }) => startConversation(body.phone, body.text, actor),
});
