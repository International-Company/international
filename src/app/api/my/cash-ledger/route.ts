import { z } from 'zod';
import { route } from '@/core/http/route';
import * as ledger from '@/modules/exchange/cash-ledger.service';

const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

/**
 * The teller's own cash, deal by deal, from an opening of zero. No teller
 * parameter: it is always the caller's, so it cannot be asked for anyone else.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.transaction.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    const result = await ledger.cashLedger(
      { from: new Date(query.from), to: new Date(query.to) },
      actor,
    );
    const amounts = (list: ledger.CashAmount[]) =>
      list.map((entry) => ({ currency: entry.currency, amount: entry.amount.toString() }));

    return {
      from: result.from.toISOString(),
      to: result.to.toISOString(),
      opening: amounts(result.opening),
      closing: amounts(result.closing),
      traded: result.traded.map((row) => ({
        ...row,
        bought: row.bought.toString(),
        sold: row.sold.toString(),
      })),
      entries: result.entries.map((entry) => ({
        ...entry,
        at: entry.at.toISOString(),
        foreign: entry.foreign && {
          currency: entry.foreign.currency,
          amount: entry.foreign.amount.toString(),
        },
        fromAmount: entry.fromAmount.toString(),
        toAmount: entry.toAmount.toString(),
        rate: entry.rate.toString(),
        cashIn: amounts(entry.cashIn),
        cashOut: amounts(entry.cashOut),
        running: amounts(entry.running),
      })),
    };
  },
});
