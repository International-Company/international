import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as transactions from '@/modules/exchange/transaction.service';

const paramsSchema = z.object({ id: z.string().min(1) });

const money = z.string().or(z.number()).transform((value) => parseMoney(value));

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.transaction.view'],
  paramsSchema,
  handler: async ({ params, actor }) => transactions.getById(params.id, actor),
});

const updateSchema = z.object({
  customerId: z.string().nullable().optional(),
  fromAmount: money.optional(),
  toCurrency: z.string().max(8).optional(),
  feeCurrency: z.string().max(8).nullable().optional(),
  feeAmount: money.optional(),
  counterpartyName: z.string().max(200).nullable().optional(),
  counterpartyPhone: z.string().max(40).nullable().optional(),
  counterpartyDoc: z.string().max(60).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  internalNotes: z.string().max(2000).nullable().optional(),
});

export const PATCH = route<z.infer<typeof updateSchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.transaction.update'],
  paramsSchema,
  bodySchema: updateSchema,
  handler: async ({ params, body, actor }) => {
    await transactions.update(params.id, body, actor);
    return { ok: true };
  },
});

const cancelSchema = z.object({ reason: z.string().min(3).max(500) });

export const DELETE = route<unknown, z.infer<typeof cancelSchema>, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.transaction.delete'],
  paramsSchema,
  querySchema: cancelSchema,
  handler: async ({ params, query, actor }) => {
    await transactions.cancel(params.id, query.reason, actor);
    return { ok: true };
  },
});
