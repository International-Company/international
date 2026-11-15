import { z } from 'zod';
import { route } from '@/core/http/route';
import { markSeen, readConversation } from '@/modules/whatsapp/bot-store';
import { answerCustomer, MAX_ANSWER_LENGTH } from '@/modules/whatsapp/inbox.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  // Opening it is reading it: what came in is no longer unread.
  handler: async ({ params }) => {
    const thread = await readConversation(params.id);
    await markSeen(params.id);
    return thread;
  },
});

// Words, a photo the screen has already shrunk (base64), or both.
const bodySchema = z
  .object({
    text: z.string().trim().max(MAX_ANSWER_LENGTH).default(''),
    image: z.string().min(1).max(6_000_000).optional(),
    /** A message of the conversation the answer quotes. */
    quoteId: z.string().min(1).max(40).optional(),
  })
  .refine((body) => body.text || body.image, { message: 'Write the answer or add a photo' });

export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) =>
    answerCustomer(params.id, body.text, actor, body.image, body.quoteId),
});
