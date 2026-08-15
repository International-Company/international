import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as counter from '@/modules/usdt/counter.service';

const paramsSchema = z.object({ id: z.string().min(1) });

const querySchema = z.object({ payoutCurrency: z.string().min(2).max(8) });

/**
 * What this arrival would pay in a given currency, right now.
 *
 * Inside the counter permission rather than the rate one: a teller must be able
 * to say the figure out loud before settling, and does not hold the board.
 */
export const GET = route<unknown, z.infer<typeof querySchema>, z.infer<typeof paramsSchema>>({
  permissions: ['usdt.counter.use'],
  paramsSchema,
  querySchema,
  handler: async ({ params, query }) => counter.quoteArrival(params.id, query.payoutCurrency),
});

const bodySchema = z.object({
  payoutCurrency: z.string().min(2).max(8),
  /** Which balance the money leaves from: the till, the broker, or part each. */
  mode: z.enum(counter.PAYOUT_MODES).default('CASH'),
  /** For a split: how much of the arrived USDT settles through the broker. */
  brokerShare: z.string().optional(),
  /** Which of the broker's accounts the transfer is instructed to. */
  payoutChannel: z.string().max(80).nullish(),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  notes: z.string().max(1000).nullish(),
});

/**
 * Pays a customer for a transfer that is already on the address.
 *
 * Priced at the board now rather than at a rate promised earlier — nothing was
 * promised. A customer who sends before agreeing a price takes the price at the
 * moment somebody is standing there to agree it.
 */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['usdt.counter.use', 'exchange.transaction.create'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    return counter.settleArrival(
      params.id,
      {
        branchId: actor.branchId,
        payoutCurrency: body.payoutCurrency.toUpperCase(),
        mode: body.mode,
        brokerShare: body.brokerShare !== undefined ? parseMoney(body.brokerShare) : undefined,
        payoutChannel: body.payoutChannel ?? null,
        customerId: body.customerId ?? null,
        counterpartyName: body.counterpartyName ?? null,
        counterpartyPhone: body.counterpartyPhone ?? null,
        notes: body.notes ?? null,
      },
      actor,
    );
  },
});
