import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { publishRate, rateBoard, rateHistory, retireRate } from '@/modules/exchange/rates.service';

const rate = z
  .string()
  .or(z.number())
  .transform((value, ctx) => {
    try {
      return parseMoney(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid rate' });
      return z.NEVER;
    }
  });

const querySchema = z.object({
  history: z.coerce.boolean().default(false),
  baseCode: z.string().optional(),
  quoteCode: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.rate.view'],
  querySchema,
  handler: async ({ query }) => {
    if (query.history) {
      return rateHistory({
        baseCode: query.baseCode,
        quoteCode: query.quoteCode,
        limit: query.limit,
      });
    }
    return rateBoard();
  },
});

const publishSchema = z.object({
  baseCode: z.string().min(2).max(8),
  quoteCode: z.string().min(2).max(8),
  /**
   * Which balance the money comes out of, and therefore which price this is.
   * Defaults to the till, so an existing caller publishes what it always did.
   */
  channel: z.enum(['CASH', 'BROKER']).default('CASH'),
  buyRate: rate,
  sellRate: rate,
  note: z.string().max(500).optional(),
});

export const POST = route<z.infer<typeof publishSchema>>({
  permissions: ['exchange.rate.manage'],
  bodySchema: publishSchema,
  handler: async ({ body, actor }) => publishRate(body, actor),
});

const retireSchema = z.object({ id: z.string().min(1) });

/** Takes one live rate off the board — for a price that should not be there. */
export const DELETE = route<unknown, z.infer<typeof retireSchema>>({
  permissions: ['exchange.rate.manage'],
  querySchema: retireSchema,
  handler: async ({ query, actor }) => retireRate(query.id, actor),
});
