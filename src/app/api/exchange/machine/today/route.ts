import { route } from '@/core/http/route';
import * as activity from '@/modules/exchange/activity.service';

/**
 * The caller's own exchanges today, and what of them is still owed by transfer.
 *
 * No parameters: the service reads the signed-in teller's work for the open
 * day and nobody else's. Amounts leave as strings — they are 1e8-scaled bigints
 * and JSON would round them through a float.
 */
export const GET = route({
  permissions: ['exchange.machine.use'],
  handler: async ({ actor }) => {
    const today = await activity.machineToday(actor);
    const amounts = (list: activity.Amount[]) =>
      list.map((entry) => ({ currency: entry.currency, amount: entry.amount.toString() }));

    return {
      ...today,
      received: amounts(today.received),
      paidCash: amounts(today.paidCash),
      paidBank: amounts(today.paidBank),
      bank: today.bank.map((entry) => ({
        ...entry,
        pending: entry.pending.toString(),
        sent: entry.sent.toString(),
      })),
    };
  },
});
