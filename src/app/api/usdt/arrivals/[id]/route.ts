import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { withTransaction } from '@/core/db/prisma';
import { parseMoney } from '@/core/money/money';
import * as counter from '@/modules/usdt/counter.service';
import { tellUsdtReceipt } from '@/modules/whatsapp/usdt-receipt';
import { createLogger } from '@/core/logger/logger';

const log = createLogger('usdt:arrivals');

const paramsSchema = z.object({ id: z.string().min(1) });

const querySchema = z.object({
  payoutCurrency: z.string().min(2).max(8),
  /** Other transfers to price with it, comma separated. */
  also: z.string().max(1000).optional(),
  /** Split in two: the coins the first deal pays for. */
  coins: z.string().max(30).optional(),
  /** Another coin than the wallet's: what one of it is worth in the wallet's. */
  coinPrice: z.string().max(30).optional(),
});

const MAX_MERGED = 19;

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
  handler: async ({ params, query }) =>
    counter.quoteArrival(
      params.id,
      query.payoutCurrency,
      undefined,
      query.also?.split(',').filter(Boolean).slice(0, MAX_MERGED) ?? [],
      query.coins?.trim() ? parseMoney(query.coins) : undefined,
      query.coinPrice?.trim() ? parseMoney(query.coinPrice) : undefined,
    ),
});

const bodySchema = z.object({
  payoutCurrency: z.string().min(2).max(8),
  /** Other transfers to settle with this one, as a single deal. */
  alsoArrivals: z.array(z.string().min(1)).max(MAX_MERGED).default([]),
  /** Split in two: the coins this first deal pays for; the rest waits for the second. */
  splitCoins: z.string().max(30).optional(),
  /** Which balance the money leaves from: the till, the broker, or part each. */
  mode: z.enum(counter.PAYOUT_MODES).default('CASH'),
  /** For a split: how much of the arrived USDT settles through the broker. */
  brokerShare: z.string().optional(),
  /** For a split, in its place: what goes by transfer, in the money paid out. */
  brokerPayout: z.string().max(30).optional(),
  /** USDT into dollars: the percentage taken on each way of paying. */
  percentCash: z.string().max(12).optional(),
  percentBroker: z.string().max(12).optional(),
  /** What the customer is paid in all, when the teller changed the computed figure. */
  payoutEdit: z.string().max(30).optional(),
  /** Paid part each: the teller's own figure for each part. */
  payoutEditCash: z.string().max(30).optional(),
  payoutEditBank: z.string().max(30).optional(),
  /** Into shekels: the teller's own price per coin, for each way of paying. */
  priceCash: z.string().max(20).optional(),
  priceBroker: z.string().max(20).optional(),
  /** Another coin than the wallet's: what one of it is worth in the wallet's. */
  coinPrice: z.string().max(30).optional(),
  /** Which of the broker's accounts the transfer is instructed to. */
  payoutChannel: z.string().max(80).nullish(),
  /** The account on that channel — a wallet number, a phone, an IBAN. */
  payoutAccount: z.string().max(80).nullish(),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  /** With no customer chosen, make one from the name and phone, so the sender is known next time. */
  saveCustomer: z.boolean().default(false),
  /** Send the customer their receipt on WhatsApp; on unless the teller left it out. */
  tellCustomer: z.boolean().default(true),
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

    const branchId = actor.branchId;
    const settle = (db?: Parameters<typeof counter.settleArrival>[3]) =>
      counter.settleArrival(
        params.id,
        {
          branchId,
          alsoArrivals: body.alsoArrivals,
          splitCoins: body.splitCoins?.trim() ? parseMoney(body.splitCoins) : undefined,
          payoutCurrency: body.payoutCurrency.toUpperCase(),
          mode: body.mode,
          brokerShare: body.brokerShare !== undefined ? parseMoney(body.brokerShare) : undefined,
          brokerPayout: body.brokerPayout !== undefined ? parseMoney(body.brokerPayout) : undefined,
          percentCash: body.percentCash !== undefined ? parseMoney(body.percentCash) : undefined,
          percentBroker:
            body.percentBroker !== undefined ? parseMoney(body.percentBroker) : undefined,
          payoutEdit: body.payoutEdit !== undefined ? parseMoney(body.payoutEdit) : undefined,
          payoutEditCash:
            body.payoutEditCash !== undefined ? parseMoney(body.payoutEditCash) : undefined,
          payoutEditBank:
            body.payoutEditBank !== undefined ? parseMoney(body.payoutEditBank) : undefined,
          priceCash: body.priceCash !== undefined ? parseMoney(body.priceCash) : undefined,
          priceBroker: body.priceBroker !== undefined ? parseMoney(body.priceBroker) : undefined,
          coinPrice: body.coinPrice?.trim() ? parseMoney(body.coinPrice) : undefined,
          payoutChannel: body.payoutChannel ?? null,
          payoutAccount: body.payoutAccount ?? null,
          customerId: body.customerId ?? null,
          counterpartyName: body.counterpartyName ?? null,
          counterpartyPhone: body.counterpartyPhone ?? null,
          saveCustomer: body.saveCustomer,
          notes: body.notes ?? null,
        },
        actor,
        db,
      );

    // Merged, it claims several transfers: either all of them or none.
    const created = await (body.alsoArrivals.length > 0 ? withTransaction((tx) => settle(tx)) : settle());
    // The customer's receipt, after the deal stands: WhatsApp failing never undoes it.
    if (body.tellCustomer) {
      void tellUsdtReceipt(created.id, actor).catch((error) =>
        log.warn('Could not send a customer their USDT receipt', { error }),
      );
    }
    return created;
  },
});
