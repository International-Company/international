import { route } from '@/core/http/route';
import { allGroups } from '@/modules/bank/group-feed.service';

/** Every group the linked numbers are in: to follow, or to pass a message on to. */
export const GET = route({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  handler: async ({ actor }) => allGroups(actor),
});
