import { z } from 'zod';
import { route } from '@/core/http/route';
import * as counter from '@/modules/usdt/counter.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** The request as it stands, without touching the chain. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['usdt.counter.use'],
  paramsSchema,
  handler: async ({ params, actor }) => counter.getRequest(params.id, actor),
});

const bodySchema = z.discriminatedUnion('action', [
  /** Poll the chain and match if a confirmed transfer is waiting. */
  z.object({ action: z.literal('check') }),
  /** Take a transfer the teller identified — by hash, or from an ambiguous set. */
  z.object({
    action: z.literal('attach'),
    chainTransactionId: z.string().min(1),
    /**
     * Settle the figure that arrived rather than the one that was asked for.
     * Sent only when the teller has been shown both and pressed the button
     * that names the difference.
     */
    acceptDifference: z.boolean().optional(),
  }),
  /** Pay the customer and post the movement. */
  z.object({ action: z.literal('complete') }),
  z.object({ action: z.literal('cancel'), reason: z.string().min(3).max(500) }),
]);

/**
 * Everything a request can be told to do.
 *
 * `check` is safe to call repeatedly — the teller's screen polls it while the
 * customer is still at the window — and is idempotent once matched.
 */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['usdt.counter.use'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => {
    switch (body.action) {
      case 'check':
        return counter.checkRequest(params.id);

      case 'attach':
        await counter.attachTransfer(params.id, body.chainTransactionId, actor, {
          acceptDifference: body.acceptDifference ?? false,
        });
        return { status: 'MATCHED' };

      case 'complete': {
        const transaction = await counter.completeRequest(params.id, actor);
        return { status: 'COMPLETED', transaction };
      }

      case 'cancel':
        await counter.cancelRequest(params.id, body.reason, actor);
        return { status: 'CANCELLED' };
    }
  },
});
