import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as transactions from '@/modules/exchange/transaction.service';
import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@/modules/exchange/posting-rules';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';

/** Amounts arrive as decimal strings and are parsed to scaled integers here. */
const money = z
  .string()
  .or(z.number())
  .transform((value, ctx) => {
    try {
      return parseMoney(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid amount' });
      return z.NEVER;
    }
  });

const querySchema = z.object({
  status: z.string().optional(),
  type: z.string().optional(),
  customerId: z.string().optional(),
  currency: z.string().optional(),
  search: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.transaction.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    return transactions.list(
      {
        ...query,
        status: query.status
          ? (query.status.split(',') as (typeof TRANSACTION_STATUSES)[number][])
          : undefined,
        type: query.type ? (query.type.split(',') as (typeof TRANSACTION_TYPES)[number][]) : undefined,
      },
      actor,
    );
  },
});

const createSchema = z.object({
  type: z.enum(TRANSACTION_TYPES),
  branchId: z.string().optional(),
  customerId: z.string().nullable().optional(),
  fromCurrency: z.string().length(3).or(z.string().max(8)),
  fromAmount: money,
  toCurrency: z.string().max(8).optional(),
  toAmount: money.optional(),
  feeCurrency: z.string().max(8).nullable().optional(),
  feeAmount: money.optional(),
  sourceAccountId: z.string().nullable().optional(),
  destinationAccountId: z.string().nullable().optional(),
  counterpartyName: z.string().max(200).nullable().optional(),
  counterpartyPhone: z.string().max(40).nullable().optional(),
  counterpartyDoc: z.string().max(60).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  internalNotes: z.string().max(2000).nullable().optional(),
  valueDate: z.coerce.date().optional(),
  /** Submit immediately instead of leaving a draft. */
  submit: z.boolean().default(true),
});

export const POST = route<z.infer<typeof createSchema>>({
  permissions: ['exchange.transaction.create'],
  bodySchema: createSchema,
  rateLimit: { key: 'transaction-create', limit: 120, windowSeconds: 60 },
  handler: async ({ body, actor }) => {
    // A user without a home branch cannot post anywhere, so resolve one rather
    // than silently writing to an arbitrary branch.
    const branchId =
      body.branchId ??
      actor.branchId ??
      (await prisma.branch.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } }))?.id;

    if (!branchId) throw errors.precondition('No active branch is configured', 'errors.noBranch');

    const { submit, ...input } = body;

    return transactions.create({ ...input, branchId }, actor, { submit });
  },
});
