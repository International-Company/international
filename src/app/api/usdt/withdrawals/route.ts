import { route } from '@/core/http/route';
import * as withdrawal from '@/modules/usdt/withdrawal.service';
import * as broadcast from '@/modules/usdt/broadcast.service';

/**
 * USDT sales the manager has not released yet.
 *
 * Behind the releasing permission rather than a viewing one: this list is a
 * queue of work for the person who can act on it, and showing it to somebody
 * who cannot would be an alarm with no handle attached.
 */
export const GET = route({
  permissions: [withdrawal.APPROVE_PERMISSION],
  handler: async ({ actor }) => {
    const [rows, sending] = await Promise.all([
      withdrawal.awaitingApproval(actor.branchId ?? null),
      broadcast.readiness(),
    ]);

    /*
     * What the program will do when the button is pressed, said before it is
     * pressed. A manager who does not know whether sending is switched on is
     * a manager who cannot tell a transfer that went from one that did not.
     */
    return {
      rows,
      sending: {
        ready: sending.ready,
        address: sending.address,
        perTransfer: sending.limits.perTransfer.toString(),
        perDay: sending.limits.perDay.toString(),
        sentToday: sending.sentToday.toString(),
      },
    };
  },
});
