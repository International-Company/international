import { z } from 'zod';
import { route } from '@/core/http/route';
import { linkOf, startLink, unlink } from '@/modules/whatsapp/teller-whatsapp.service';

/** The asker's own number: each teller links and unlinks theirs alone. */
export const GET = route({
  permissions: ['customers.whatsapp'],
  handler: async ({ actor }) => linkOf(actor.id),
});

const bodySchema = z.object({
  action: z.enum(['start', 'unlink']),
  /** Linking by number rather than QR. */
  phone: z.string().trim().min(8).max(30).optional(),
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema,
  handler: async ({ body, actor }) =>
    body.action === 'start' ? startLink(actor.id, body.phone) : unlink(actor.id),
});
