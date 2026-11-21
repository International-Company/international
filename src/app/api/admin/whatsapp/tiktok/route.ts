import { z } from 'zod';
import { route } from '@/core/http/route';
import * as settings from '@/modules/settings/settings.service';
import { MAX_TIKTOK_RECIPIENTS, parseTiktokRecipients } from '@/modules/tiktok/tiktok-message';

/** Who TikTok withdrawals are sent to, each with the group that is theirs. */
export const GET = route({
  permissions: ['settings.view'],
  handler: async () => parseTiktokRecipients(await settings.getString('whatsapp.tiktokRecipients')),
});

const bodySchema = z.object({
  recipients: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        group: z.object({ id: z.string().trim().min(1).max(120), name: z.string().max(200) }),
      }),
    )
    .max(MAX_TIKTOK_RECIPIENTS),
});

/** All of them at once, as the panel holds them. */
export const PUT = route<z.infer<typeof bodySchema>>({
  permissions: ['settings.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const recipients = parseTiktokRecipients(JSON.stringify(body.recipients));
    await settings.setMany({ 'whatsapp.tiktokRecipients': JSON.stringify(recipients) }, actor);
    return recipients;
  },
});
