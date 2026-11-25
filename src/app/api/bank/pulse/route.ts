import { route } from '@/core/http/route';
import { deskPulse } from '@/modules/bank/bank.service';

/** Whether anything on the desk changed: a short fingerprint the open desk compares. */
export const GET = route({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  handler: async ({ actor }) => ({ pulse: await deskPulse(actor) }),
});
