import { route } from '@/core/http/route';
import * as withdrawal from '@/modules/usdt/withdrawal.service';

/**
 * USDT sales the manager has not released yet.
 *
 * Behind the releasing permission rather than a viewing one: this list is a
 * queue of work for the person who can act on it, and showing it to somebody
 * who cannot would be an alarm with no handle attached.
 */
export const GET = route({
  permissions: [withdrawal.APPROVE_PERMISSION],
  handler: async ({ actor }) => withdrawal.awaitingApproval(actor.branchId ?? null),
});
