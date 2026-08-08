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
 * The only thing that can be done to a posted transaction.
 *
 * Reversal is the manager's control over the teller's work, and the service
 * checks the permission again for itself rather than trusting this route to be
 * the only way in.
 */
const bodySchema = z.object({
  action: z.literal('reverse'),
  reason: z.string().min(3).max(500),
});

export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.transaction.reverse'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => transactions.reverse(params.id, body.reason, actor),
});
