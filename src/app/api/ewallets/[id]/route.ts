import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { topUp, walletReport } from '@/modules/treasury/ewallet.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** One wallet since its last count, line by line. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['treasury.handover.manage', 'ewallet.use'],
  paramsSchema,
  handler: async ({ params, actor }) => walletReport(params.id, actor),
});

const bodySchema = z.object({
  action: z.literal('topup'),
  source: z.enum(['CASH', 'BROKER']),
  direction: z.enum(['IN', 'OUT']).default('IN'),
  amount: z.string().min(1).max(30),
  note: z.string().max(300).nullish(),
});

/** Money into the wallet from the bank balance or the cash, or back out to either. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['treasury.handover.manage'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) =>
    topUp(params.id, { source: body.source, direction: body.direction, amount: parseMoney(body.amount), note: body.note ?? null }, actor),
});
