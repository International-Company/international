import { route } from '@/core/http/route';
import { unpriced } from '@/modules/exchange/remittance.service';

/** Remittances sent whose correspondent's price is still to be written. */
export const GET = route({
  permissions: ['exchange.remittance.use'],
  handler: async ({ actor }) => unpriced(actor),
});
