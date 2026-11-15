import { route } from '@/core/http/route';
import { unreadCount as officeUnread } from '@/modules/whatsapp/bot-store';
import { unreadCount as mineUnread } from '@/modules/whatsapp/teller-whatsapp.service';

/**
 * What waits unread for whoever asks: the private number's, which everyone with
 * the inbox shares, and their own number's. The sidebar shows it beside the inbox.
 */
export const GET = route({
  permissions: ['customers.whatsapp'],
  handler: async ({ actor }) => {
    const [office, mine] = await Promise.all([officeUnread(), mineUnread(actor.id)]);
    return { office, mine, total: office + mine };
  },
});
