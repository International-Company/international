import { z } from 'zod';
import { route } from '@/core/http/route';
import { answer, readChat } from '@/modules/whatsapp/teller-whatsapp.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  handler: async ({ params, actor }) => readChat(actor.id, params.id),
});

// Words, a photo the screen has already shrunk (base64), or both.
const bodySchema = z
  .object({
    text: z.string().trim().max(2000).default(''),
    image: z.string().min(1).max(6_000_000).optional(),
  })
  .refine((body) => body.text || body.image, { message: 'Write the answer or add a photo' });

export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => answer(actor.id, params.id, body.text, body.image),
});
