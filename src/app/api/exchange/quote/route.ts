import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { quoteExchange } from '@/modules/exchange/rates.service';

const querySchema = z.object({
  from: z.string().min(2).max(8),
  to: z.string().min(2).max(8),
  amount: z.string(),
});

/**
 * Live pricing for the transaction form.
 *
 * The quote is advisory — the server re-prices from the board when the
 * transaction is actually created, so a stale browser tab cannot lock in an
 * old rate.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.rate.view'],
  querySchema,
  handler: async ({ query }) => {
    const amount = parseMoney(query.amount);
    if (amount <= 0n) {
      return { toAmount: '0', rate: '0', profit: '0', side: 'BUY', inverted: false, rateId: '' };
    }

    const quote = await quoteExchange(query.from, query.to, amount);

    return {
      fromCurrency: quote.fromCurrency,
      toCurrency: quote.toCurrency,
      fromAmount: quote.fromAmount,
      toAmount: quote.toAmount,
      rate: quote.rate,
      midRate: quote.midRate,
      rateId: quote.rateId,
      side: quote.side,
      inverted: quote.inverted,
      profit: quote.profit,
    };
  },
});
