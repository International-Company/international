import { z } from 'zod';
import { route } from '@/core/http/route';
import { listChats, startChat } from '@/modules/whatsapp/teller-whatsapp.service';

/** The teller's own number: only ever the conversations of whoever asks. */
export const GET = route({
  permissions: ['customers.whatsapp'],
  handler: async ({ actor }) => listChats(actor.id),
});

const bodySchema = z.object({
  phone: z.string().trim().min(5).max(30),
  text: z.string().trim().min(1).max(2000),
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema,
  handler: async ({ body, actor }) => startChat(actor.id, body.phone, body.text),
});
