import { route } from '@/core/http/route';
import * as whatsapp from '@/modules/whatsapp/whatsapp.service';

/** The groups the linked number is in, for choosing where deals go. */
export const GET = route({
  permissions: ['settings.manage'],
  handler: async () => whatsapp.groups(),
});
