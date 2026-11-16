import { route } from '@/core/http/route';
import { desk } from '@/modules/bank/bank.service';

/** The bank desk: what is still to be sent, and what was sent today. */
export const GET = route({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  handler: async ({ actor }) => desk(actor),
});
