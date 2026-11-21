import { route } from '@/core/http/route';
import * as settings from '@/modules/settings/settings.service';
import { parseTiktokRecipients } from '@/modules/tiktok/tiktok-message';

/** The names a TikTok withdrawal may be sent to — the names alone, not their groups. */
export const GET = route({
  permissions: ['exchange.remittance.use'],
  handler: async () =>
    parseTiktokRecipients(await settings.getString('whatsapp.tiktokRecipients')).map((entry) => entry.name),
});
