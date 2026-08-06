import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { listChainTransactions, recordManualTransfer } from '@/modules/usdt/sync.service';

const querySchema = z.object({
  walletId: z.string().optional(),
  direction: z.enum(['IN', 'OUT']).optional(),
  status: z.string().optional(),
  reconciled: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  search: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['usdt.transaction.view'],
  querySchema,
  handler: async ({ query }) => listChainTransactions(query),
});

const manualSchema = z.object({
  walletId: z.string().min(1),
  txHash: z.string().min(6).max(120),
  direction: z.enum(['IN', 'OUT']),
  fromAddress: z.string().min(4).max(120),
  toAddress: z.string().min(4).max(120),
  amount: z.string().or(z.number()),
  blockNumber: z.coerce.bigint().nullable().optional(),
  blockTimestamp: z.coerce.date().nullable().optional(),
  notes: z.string().max(1000).optional(),
});

export const POST = route<z.infer<typeof manualSchema>>({
  permissions: ['usdt.wallet.manage'],
  bodySchema: manualSchema,
  handler: async ({ body, actor }) => {
    const id = await recordManualTransfer(
      { ...body, amount: parseMoney(body.amount) },
      actor,
    );
    return { id };
  },
});
