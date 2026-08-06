import { route } from '@/core/http/route';
import { pendingApprovals } from '@/modules/exchange/transaction.service';

export const GET = route({
  permissions: ['exchange.transaction.approve'],
  handler: async ({ actor }) => pendingApprovals(actor),
});
