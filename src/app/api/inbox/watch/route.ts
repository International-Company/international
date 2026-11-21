import { route } from '@/core/http/route';
import { listConversations } from '@/modules/whatsapp/bot-store';
import { watchedNumbers } from '@/modules/whatsapp/teller-whatsapp.service';

/**
 * What the manager may watch: each person's own number that has conversations,
 * and the private number. Read only — answering stays with whoever's number it is.
 */
export const GET = route({
  permissions: ['customers.whatsapp.monitor'],
  handler: async () => {
    const [numbers, privateRows] = await Promise.all([watchedNumbers(), listConversations()]);
    return {
      numbers,
      private: {
        chats: privateRows.length,
        unread: privateRows.reduce((sum, row) => sum + (row.unread ?? 0), 0),
      },
    };
  },
});
