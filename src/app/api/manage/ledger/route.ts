import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as cutoff from '@/modules/ledger/cutoff.service';
import * as ledger from '@/modules/ledger/ledger.service';

/**
 * The ledger's one endpoint: read a day, or approve a rate it will be valued at.
 *
 * Reading is a GET because a day's result is a fact to be looked at. Approving
 * a rate is a POST because it decides what every figure on that screen means.
 */

const querySchema = z.object({
  /** `YYYY-MM-DD`. Defaults to today. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * Parses a day key as **local** midnight.
 *
 * `new Date('2026-08-10')` is midnight UTC, which in any timezone ahead of it
 * is the previous evening — so the manager asking for the 10th would be handed
 * the 9th's position.
 */
function parseDay(value: string | undefined): Date {
  if (!value) return new Date();
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year!, month! - 1, day!);
}

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['ledger.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');
    const date = parseDay(query.date);

    const [result, rates, funding] = await Promise.all([
      ledger.dayResult(actor.branchId, date),
      cutoff.ratesOn(date),
      ledger.fundingOn(actor.branchId, date),
    ]);

    return {
      ...result,
      rates: [...rates].map(([currency, entry]) => ({
        currency,
        rate: entry.rate,
        setOn: entry.setOn,
      })),
      fundingLines: funding,
    };
  },
});

const bodySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().min(2).max(8),
  /** Units of the base currency for one unit of this one. */
  rate: z.string(),
  note: z.string().max(300).nullish(),
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['ledger.cutoff.manage'],
  bodySchema,
  handler: async ({ body, actor }) =>
    cutoff.setRate(
      {
        date: parseDay(body.date),
        currencyCode: body.currency,
        rate: parseMoney(body.rate),
        note: body.note ?? null,
      },
      actor,
    ),
});
