import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as withdrawals from '@/modules/usdt/withdrawal.service';

const querySchema = z.object({
  currency: z.string().min(2).max(8),
  pay: z.string(),
});

/**
 * Live pricing for the withdrawal screen, including whether the branch can send.
 *
 * Advisory, like every quote in this system: `record` prices again from the
 * board. What it adds is the balance check, so the teller never names a figure
 * the branch has no coins to honour.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['usdt.withdrawal.use'],
  querySchema,
  handler: async ({ query, actor }) => {
    const priced = await withdrawals.quote({
      actorId: actor.id,
      payCurrency: query.currency.toUpperCase(),
      payAmount: parseMoney(query.pay),
    });

    // The spread is stripped for anyone without the financial permission — the
    // teller quotes the customer, the manager watches the margin.
    const seesMargin = actor.permissions.includes('exchange.margin.view');
    const side = (leg: (typeof priced)['cash']) =>
      leg && {
        fromAmount: leg.fromAmount,
        toAmount: leg.toAmount,
        rate: leg.rate,
        profit: seesMargin ? leg.profit : null,
      };

    return {
      payCurrency: priced.payCurrency,
      cash: side(priced.cash),
      broker: side(priced.broker),
      availableUsdt: priced.availableUsdt,
    };
  },
});

const bodySchema = z.object({
  currency: z.string().min(2).max(8),
  pay: z.string(),
  mode: z.enum(['CASH', 'BROKER', 'SPLIT']).default('CASH'),
  /** For a split: how much of the payment settles through the broker. */
  brokerShare: z.string().optional(),
  /** Which of the broker's accounts the customer paid into. */
  intakeChannel: z.string().max(80).nullish(),
  address: z.string().min(10).max(120),
  walletId: z.string().min(1),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  notes: z.string().max(1000).nullish(),
});

/** Prices and posts in one press. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['usdt.withdrawal.use', 'exchange.transaction.create'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    return withdrawals.record(
      {
        payCurrency: body.currency.toUpperCase(),
        payAmount: parseMoney(body.pay),
        mode: body.mode,
        brokerShare: body.brokerShare !== undefined ? parseMoney(body.brokerShare) : undefined,
        intakeChannel: body.intakeChannel ?? null,
        address: body.address,
        walletId: body.walletId,
        branchId: actor.branchId,
        customerId: body.customerId ?? null,
        counterpartyName: body.counterpartyName ?? null,
        counterpartyPhone: body.counterpartyPhone ?? null,
        notes: body.notes ?? null,
      },
      actor,
    );
  },
});
