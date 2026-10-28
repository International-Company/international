import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as ledger from '@/modules/exchange/cash-ledger.service';

const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  /** The counter's local day, for the opening box the teller entered for it. */
  day: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const bodySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lines: z
    .array(z.object({ currency: z.string().min(2).max(8), amount: z.string() }))
    .min(1)
    .max(20),
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
      { from: new Date(query.from), to: new Date(query.to), day: query.day },
      actor,
    );
    const amounts = (list: ledger.CashAmount[]) =>
      list.map((entry) => ({ currency: entry.currency, amount: entry.amount.toString() }));

    return {
      from: result.from.toISOString(),
      to: result.to.toISOString(),
      opening: amounts(result.opening),
      openingSet: result.openingSet,
      currencies: result.currencies,
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

/** The teller opens his own box for a day, or corrects it. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.transaction.view'],
  bodySchema,
  handler: async ({ body, actor }) => {
    await ledger.setOpening(
      {
        day: body.day,
        lines: body.lines.map((line) => ({
          currency: line.currency.toUpperCase(),
          amount: parseMoney(line.amount || '0'),
        })),
      },
      actor,
    );
    return { ok: true };
  },
});
