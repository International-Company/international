import { z } from 'zod';
import { route } from '@/core/http/route';
import * as activity from '@/modules/exchange/activity.service';

const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
});

/**
 * A teller's report on himself: what he recorded, and what it did to the
 * balances in his hands.
 *
 * No teller parameter. The service reads the caller's own work and the
 * caller's own drawers, so there is no way to ask this for somebody else.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.transaction.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    const window = { from: new Date(query.from), to: new Date(query.to) };
    const [work, flows] = await Promise.all([
      activity.activity({ ...window, own: true }, actor),
      activity.balanceFlow(window, actor),
    ]);

    const amounts = (list: activity.Amount[] | null) =>
      list?.map((entry) => ({ currency: entry.currency, amount: entry.amount.toString() })) ?? null;

    const mine = work.tellers.find((teller) => teller.tellerId === actor.id) ?? null;

    return {
      summary: mine && { ...mine, lastAt: mine.lastAt?.toISOString() ?? null },
      types: work.types.map((totals) => ({
        ...totals,
        received: amounts(totals.received),
        paid: amounts(totals.paid),
        margin: amounts(totals.margin),
      })),
      balances: flows.map((flow) => ({
        currency: flow.currency,
        kind: flow.kind,
        decimals: flow.decimals,
        handedIn: flow.handedIn.toString(),
        tradeIn: flow.tradeIn.toString(),
        tradeOut: flow.tradeOut.toString(),
        handedBack: flow.handedBack.toString(),
        other: flow.other.toString(),
        balance: flow.balance.toString(),
      })),
    };
  },
});
