import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { RATE_CHANNELS } from '@/modules/exchange/rates.service';
import * as exceptions from '@/modules/exchange/price-exception.service';
import * as settings from '@/modules/settings/settings.service';

// A rate is scaled the same 1e8 as money, so `parseMoney` reads one exactly.

/**
 * Breaking a price, over HTTP.
 *
 * The teller's half sends what he wants; the manager's half sends yes or no.
 * Neither of them ever sends a rate that is used to move money — the approval
 * carries the price, and `machine.record` reads it from there.
 *
 * No permission at the door: the two sides need different ones and the service
 * knows which side the caller is on. Declaring one here would have to be the
 * weaker of the two.
 */

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('request'),
    fromCurrency: z.string().min(2).max(8),
    toCurrency: z.string().min(2).max(8),
    channel: z.enum(RATE_CHANNELS).default('CASH'),
    maxFromAmount: z.string(),
    requestedRate: z.string(),
    reason: z.string().max(300).nullish(),
    /** Typed into the dollar's price on the exchange screen. */
    direct: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('decide'),
    id: z.string().min(1),
    approve: z.boolean(),
    rate: z.string().nullish(),
    note: z.string().max(300).nullish(),
  }),
  z.object({ action: z.literal('cancel'), id: z.string().min(1) }),
]);

/**
 * How each pair is read by people, asked once per pair: "1 USD = 3.60 ILS" is
 * the price whichever way the money goes, and the stored rate is not.
 */
function readings() {
  const known = new Map<string, Promise<boolean>>();
  const inverted = (from: string, to: string) => {
    const key = `${from}/${to}`;
    if (!known.has(key)) known.set(key, exceptions.readInverted(from, to));
    return known.get(key)!;
  };
  /** The prices of a row as read, and the pair named the way it is read. */
  return async (
    row: { fromCurrency: string; toCurrency: string },
    rates: Record<string, bigint | null | undefined>,
  ) => {
    const flip = await inverted(row.fromCurrency, row.toCurrency);
    const prices: Record<string, string | null> = {};
    for (const [name, rate] of Object.entries(rates)) {
      prices[name] = exceptions.asPrice(rate ?? null, flip);
    }
    return {
      ...prices,
      base: flip ? row.toCurrency : row.fromCurrency,
      counter: flip ? row.fromCurrency : row.toCurrency,
    };
  };
}

export const GET = route({
  handler: async ({ actor }) => {
    const canApprove = actor.permissions.includes(exceptions.APPROVE_PERMISSION);
    const read = readings();

    if (!canApprove) {
      const rows = await exceptions.mine(actor.id);
      return {
        role: 'teller' as const,
        // Whether a granted price holds past the amount it was asked for.
        anyAmount: await settings.getBoolean('exchange.priceException.anyAmount'),
        mine: await Promise.all(
          rows.map(async (row) => ({
            id: row.id,
            reference: row.reference,
            status: row.status,
            fromCurrency: row.fromCurrency,
            toCurrency: row.toCurrency,
            channel: row.channel,
            maxFromAmount: row.maxFromAmount.toString(),
            requestedRate: row.requestedRate.toString(),
            approvedRate: row.approvedRate?.toString() ?? null,
            ...(await read(row, {
              requestedPrice: row.requestedRate,
              approvedPrice: row.approvedRate,
            })),
            expiresAt: row.expiresAt?.toISOString() ?? null,
          })),
        ),
      };
    }

    const [waiting, done] = await Promise.all([
      exceptions.pending(actor.branchId ?? null),
      exceptions.recent(actor.branchId ?? null),
    ]);

    /*
     * The cost is computed for a request still waiting, and read off the row
     * once it has been decided. Live while it matters, frozen once it has been
     * acted on — the manager should never see a decision he made yesterday
     * re-explained with today's cost.
     */
    const costs = new Map<string, bigint | null>();
    for (const row of waiting) {
      const key = `${row.fromCurrency}/${row.toCurrency}`;
      if (!costs.has(key)) costs.set(key, await exceptions.costRateFor(row.fromCurrency, row.toCurrency));
    }

    return {
      role: 'manager' as const,
      pending: await Promise.all(
        waiting.map(async (row) => {
        const cost = costs.get(`${row.fromCurrency}/${row.toCurrency}`) ?? null;
        return {
          ...(await read(row, {
            boardPrice: row.boardRate,
            requestedPrice: row.requestedRate,
            costPrice: cost,
          })),
          id: row.id,
          reference: row.reference,
          tellerNameEn: row.requestedBy.fullNameEn,
          tellerNameAr: row.requestedBy.fullNameAr,
          fromCurrency: row.fromCurrency,
          toCurrency: row.toCurrency,
          channel: row.channel,
          maxFromAmount: row.maxFromAmount.toString(),
          boardRate: row.boardRate.toString(),
          requestedRate: row.requestedRate.toString(),
          costRate: cost?.toString() ?? null,
          /*
           * What the office gives up if it says yes, in the currency it hands
           * out, at the largest amount the approval would cover. The rate
           * difference alone reads as a rounding error; this is the figure the
           * decision is actually about.
           */
          concession: (
            ((row.requestedRate - row.boardRate) * row.maxFromAmount) /
            100000000n
          ).toString(),
          // A higher rate is worse for the office, so it is above cost while it
          // stays below the cost rate.
          aboveCost: cost === null ? null : row.requestedRate < cost,
          reason: row.reason,
          createdAt: row.createdAt.toISOString(),
        };
        }),
      ),
      recent: await Promise.all(
        done.map(async (row) => ({
        ...(await read(row, {
          boardPrice: row.boardRate,
          approvedPrice: row.approvedRate,
          costPrice: row.costRate,
        })),
        id: row.id,
        reference: row.reference,
        status: row.status,
        tellerNameEn: row.requestedBy.fullNameEn,
        tellerNameAr: row.requestedBy.fullNameAr,
        approverNameEn: row.approvedBy?.fullNameEn ?? null,
        approverNameAr: row.approvedBy?.fullNameAr ?? null,
        fromCurrency: row.fromCurrency,
        toCurrency: row.toCurrency,
        boardRate: row.boardRate.toString(),
        approvedRate: row.approvedRate?.toString() ?? null,
        costRate: row.costRate?.toString() ?? null,
        transaction: row.usedByTransaction?.reference ?? null,
        createdAt: row.createdAt.toISOString(),
        })),
      ),
    };
  },
});

export const POST = route<z.infer<typeof bodySchema>>({
  bodySchema,
  handler: async ({ body, actor }) => {
    if (body.action === 'request') {
      const fromCurrency = body.fromCurrency.toUpperCase();
      const toCurrency = body.toCurrency.toUpperCase();
      // Typed as the counter says it, "1 USD = 3.60 ILS"; stored as the deal runs.
      const inverted = await exceptions.readInverted(fromCurrency, toCurrency);
      const row = await exceptions.request(
        {
          fromCurrency,
          toCurrency,
          channel: body.channel,
          maxFromAmount: parseMoney(body.maxFromAmount),
          requestedRate: exceptions.fromPrice(parseMoney(body.requestedRate), inverted),
          reason: body.reason,
          direct: body.direct ?? false,
        },
        actor,
      );
      return { id: row.id, reference: row.reference, status: row.status };
    }

    if (body.action === 'cancel') {
      await exceptions.cancel(body.id, actor);
      return { cancelled: true };
    }

    // A price granted other than the one asked for is typed the way it is read, too.
    let rate: bigint | undefined;
    if (body.rate) {
      const pair = await exceptions.pairOf(body.id);
      rate = exceptions.fromPrice(
        parseMoney(body.rate),
        await exceptions.readInverted(pair.fromCurrency, pair.toCurrency),
      );
    }
    const decided = await exceptions.decide(
      body.id,
      {
        approve: body.approve,
        rate,
        note: body.note,
      },
      actor,
    );
    return { status: decided.status };
  },
});
