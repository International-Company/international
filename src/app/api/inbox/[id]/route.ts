import { z } from 'zod';
import { route } from '@/core/http/route';
import { readConversation } from '@/modules/whatsapp/bot-store';
import { answerCustomer, MAX_ANSWER_LENGTH } from '@/modules/whatsapp/inbox.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  handler: async ({ params }) => readConversation(params.id),
});

const bodySchema = z.object({ text: z.string().trim().min(1).max(MAX_ANSWER_LENGTH) });

export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => answerCustomer(params.id, body.text, actor),
});
