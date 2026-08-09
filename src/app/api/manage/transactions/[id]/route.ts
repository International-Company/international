import { z } from 'zod';
import { route } from '@/core/http/route';
import * as transactions from '@/modules/exchange/transaction.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.transaction.view'],
  paramsSchema,
  handler: async ({ params, actor }) => transactions.getById(params.id, actor),
});

/**
 * The two things that can be done to a posted transaction.
 *
 * Reversal is the manager's control over the teller's work. Confirming a
 * transfer is the manager saying a promise was kept. Both services check their
 * own permission rather than trusting this route to be the only way in, which
 * is why the route asks for neither: each action is gated where it is done.
 */
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reverse'), reason: z.string().min(3).max(500) }),
  z.object({ action: z.literal('confirmTransfer') }),
]);

export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.transaction.view'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) =>
    body.action === 'reverse'
      ? transactions.reverse(params.id, body.reason, actor)
      : transactions.confirmTransfer(params.id, actor),
});
