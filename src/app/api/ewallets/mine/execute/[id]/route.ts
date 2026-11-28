import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { execute } from '@/modules/treasury/ewallet.service';

const paramsSchema = z.object({ id: z.string().min(1) });
const bodySchema = z.object({
  /** The receipt of the transfer sent from the wallet's app. */
  receipt: z.string().min(10).max(12_000_000),
  /** What actually left the wallet, when it differs from what was asked. */
  amount: z.string().max(30).nullish(),
});

/** A transfer handed to the wallet, sent: the receipt kept, the transfer marked sent, the wallet debited. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['ewallet.use', 'treasury.handover.manage'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) =>
    execute(params.id, { receipt: body.receipt, amount: body.amount?.trim() ? parseMoney(body.amount) : null }, actor),
});
