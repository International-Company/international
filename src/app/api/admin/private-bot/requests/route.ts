import { route } from '@/core/http/route';
import { listRequests } from '@/modules/whatsapp/bot-store';

export const GET = route({
  permissions: ['settings.view'],
  handler: async () => listRequests(),
});
