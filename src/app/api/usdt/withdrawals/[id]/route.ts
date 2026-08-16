import { z } from 'zod';
import { route } from '@/core/http/route';
import * as withdrawal from '@/modules/usdt/withdrawal.service';

const paramsSchema = z.object({ id: z.string().min(1) });

const bodySchema = z.object({
  approve: z.boolean(),
  /** Required on a decline — the teller has to be able to tell the customer. */
  note: z.string().max(500).nullish(),
});

/**
 * Release a USDT sale for sending, or refuse it.
 *
 * Refusing reverses the sale: the coins go back on the balance and the
 * customer's money comes back out of the till, because they are owed it. The
 * service does that, not this route — the decision and its consequence are one
 * act and must not be separable by whoever calls in.
 */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: [withdrawal.APPROVE_PERMISSION],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) =>
    withdrawal.decide(params.id, { approve: body.approve, note: body.note ?? null }, actor),
});
