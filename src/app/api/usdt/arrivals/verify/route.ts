import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as counter from '@/modules/usdt/counter.service';

const bodySchema = z.object({
  walletId: z.string().min(1),
  /** What the teller says arrived, as the customer read it to them. */
  amount: z.string(),
  payoutCurrency: z.string().min(2).max(8),
});

/**
 * Does the money the customer says they sent actually exist?
 *
 * A POST rather than a GET because it reaches the chain — a real call to a
 * provider, on a button the teller presses on purpose — and because the answer
 * is the point at which a payout becomes possible.
 *
 * Inside the counter permission, like everything else this screen does: the
 * teller is told the figure they are about to hand over without being handed
 * the rate board.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['usdt.counter.use'],
  bodySchema,
  handler: async ({ body }) =>
    counter.findArrival({
      walletId: body.walletId,
      amount: parseMoney(body.amount),
      payoutCurrency: body.payoutCurrency,
    }),
});
