import { route } from '@/core/http/route';
import { myWallet } from '@/modules/treasury/ewallet.service';

/** The teller's own wallet: what it holds, what waits on it, what it sent since the last count. */
export const GET = route({
  permissions: ['ewallet.use'],
  handler: async ({ actor }) => ({ report: await myWallet(actor) }),
});
