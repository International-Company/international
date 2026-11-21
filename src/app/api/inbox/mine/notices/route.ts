import { z } from 'zod';
import { route } from '@/core/http/route';
import { createNotice, listNotices } from '@/modules/whatsapp/remittance-notice.service';

/** The teller's remittance notices: those being checked, and the last days' others. */
export const GET = route({
  permissions: ['customers.whatsapp'],
  handler: async ({ actor }) => listNotices(actor.id),
});

const bodySchema = z.object({ messageId: z.string().min(1).max(40) });

/** A photo of a customer's conversation, taken as a remittance notice. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema,
  handler: async ({ body, actor }) => createNotice(actor.id, body.messageId),
});
