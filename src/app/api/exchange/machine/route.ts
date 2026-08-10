import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as machine from '@/modules/exchange/machine.service';

const querySchema = z.object({
  from: z.string().min(2).max(8),
  to: z.string().min(2).max(8),
  /** Exactly one of these — whichever side of the counter named a figure. */
  pay: z.string().optional(),
  receive: z.string().optional(),
  /** Which channel a reverse-priced amount is sized against. */
  through: z.enum(['CASH', 'BROKER']).optional(),
});

/**
 * Live pricing for the machine keypad, including whether the drawer can pay.
 *
 * Advisory, like every quote in this system: `record` prices again from the
 * board. What it adds over the generic quote endpoint is the reverse direction
 * and the availability check, so the teller never reads out a figure the branch
 * cannot honour.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.machine.use'],
  querySchema,
  handler: async ({ query, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');
    if ((query.pay === undefined) === (query.receive === undefined)) {
      throw errors.validation([
        { path: 'amount', message: 'Give either the amount paid or the amount received' },
      ]);
    }

    const priced = await machine.quote({
      fromCurrency: query.from.toUpperCase(),
      toCurrency: query.to.toUpperCase(),
      fromAmount: query.pay !== undefined ? parseMoney(query.pay) : undefined,
      toAmount: query.receive !== undefined ? parseMoney(query.receive) : undefined,
      reverseThrough: query.through,
      branchId: actor.branchId,
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
      fromCurrency: priced.fromCurrency,
      toCurrency: priced.toCurrency,
      cash: side(priced.cash),
      broker: side(priced.broker),
      availableCash: priced.availableCash,
      availableBroker: priced.availableBroker,
      requiresCustomer: priced.requiresCustomer,
      overLimit: priced.overLimit,
    };
  },
});

const bodySchema = z.object({
  from: z.string().min(2).max(8),
  to: z.string().min(2).max(8),
  /** How the payout leaves the branch, and therefore which price applies. */
  mode: z.enum(['CASH', 'BROKER', 'SPLIT']).default('CASH'),
  pay: z.string().optional(),
  receive: z.string().optional(),
  /**
   * For a split: how much of what the customer hands over settles through the
   * broker. The till takes the rest, and each part is priced at its own rate.
   */
  brokerShare: z.string().optional(),
  /** Which of the broker's accounts the transfer is instructed to. */
  payoutChannel: z.string().max(80).nullish(),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  notes: z.string().max(1000).nullish(),
});

/** Prices and posts in one press. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.machine.use', 'exchange.transaction.create'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    return machine.record(
      {
        fromCurrency: body.from.toUpperCase(),
        toCurrency: body.to.toUpperCase(),
        mode: body.mode,
        fromAmount: body.pay !== undefined ? parseMoney(body.pay) : undefined,
        toAmount: body.receive !== undefined ? parseMoney(body.receive) : undefined,
        brokerShare: body.brokerShare !== undefined ? parseMoney(body.brokerShare) : undefined,
        payoutChannel: body.payoutChannel ?? null,
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
