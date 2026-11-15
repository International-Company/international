import { route } from '@/core/http/route';
import { listConversations } from '@/modules/whatsapp/bot-store';

export const GET = route({
  permissions: ['customers.whatsapp'],
  handler: async () => listConversations(),
});
