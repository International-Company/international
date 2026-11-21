import { z } from 'zod';
import { route } from '@/core/http/route';
import { busyFor, report } from '@/modules/whatsapp/inbox-presence';

/** Who else is in which customer's conversation right now. */
export const GET = route({
  permissions: ['customers.whatsapp'],
  handler: async ({ actor }) => busyFor(actor.id),
});

const bodySchema = z.object({
  /** The customer's number whose conversation is open; null, none. */
  phone: z.string().trim().max(30).nullable(),
  typing: z.boolean().default(false),
});

/** The conversation this person has open, and whether they are typing in it. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema,
  handler: async ({ body, actor, session }) => {
    report({ id: actor.id, name: session.user.fullNameAr || actor.name }, body.phone || null, body.typing);
    return busyFor(actor.id);
  },
});
