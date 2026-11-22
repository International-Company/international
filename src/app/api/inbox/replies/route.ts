import { z } from 'zod';
import { route } from '@/core/http/route';
import { listReplies, saveReply } from '@/modules/whatsapp/inbox-organise.service';

/** Who may offer a reply to the whole office: whoever watches the office's numbers. */
const SHARER = 'customers.whatsapp.monitor';

/** The replies this person is offered with "/": their own and the office's. */
export const GET = route({
  permissions: ['customers.whatsapp'],
  handler: async ({ actor }) => listReplies(actor.id),
});

const bodySchema = z.object({
  id: z.string().min(1).max(40).optional(),
  shortcut: z.string().trim().min(1).max(40),
  text: z.string().trim().min(1).max(2000),
  shared: z.boolean().default(false),
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema,
  handler: async ({ body, actor }) => saveReply(actor.id, body, actor.permissions.includes(SHARER)),
});
