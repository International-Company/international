import { route } from '@/core/http/route';
import * as whatsapp from '@/modules/whatsapp/whatsapp.service';

/** The groups the linked numbers are in, each with the number in it, for choosing where deals go. */
export const GET = route({
  permissions: ['settings.manage'],
  handler: async () => whatsapp.groups(),
});
