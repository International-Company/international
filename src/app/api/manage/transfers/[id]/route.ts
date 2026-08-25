import { z } from 'zod';
import { route } from '@/core/http/route';
import * as transfers from '@/modules/drawers/transfer.service';

/**
 * Deciding what happens to a transfer that is already recorded.
 *
 * Three acts, one endpoint, because they are the same sentence in three tenses:
 * let it go ahead, say it landed, take it back. Each is refused by the service
 * unless the transfer is in the state that act belongs to — an arrival cannot
 * be confirmed for money that never left, and a reversal cannot undo a transfer
 * that was refused before it moved anything.
 *
 * All three are the manager's. `exchange.transfer.use` opens the door; the
 * service checks for `exchange.drawer.manage` behind it, which is the check
 * that matters: whoever can say "it arrived" can say it of money that never
 * did.
 */

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    arrivedImmediately: z.boolean().default(false),
  }),
  z.object({ action: z.literal('reject'), note: z.string().max(500).optional() }),
  z.object({ action: z.literal('confirm'), proof: z.string().max(500).optional() }),
  z.object({ action: z.literal('reverse'), reason: z.string().max(500).optional() }),
]);

export const POST = route<z.infer<typeof bodySchema>, unknown, { id: string }>({
  permissions: ['exchange.transfer.use'],
  bodySchema,
  handler: async ({ body, params, actor }) => {
    const { id } = params;

    if (body.action === 'approve' || body.action === 'reject') {
      const decided = await transfers.decide(
        id,
        {
          approve: body.action === 'approve',
          arrivedImmediately: body.action === 'approve' ? body.arrivedImmediately : false,
          note: body.action === 'reject' ? (body.note ?? null) : null,
        },
        actor,
      );
      return { status: decided.status, reference: decided.reference };
    }

    if (body.action === 'confirm') {
      const arrived = await transfers.confirmArrival(id, { proof: body.proof ?? null }, actor);
      return { status: arrived.status, reference: arrived.reference };
    }

    const reversed = await transfers.reverse(id, body.reason ?? null, actor);
    return { status: reversed.status, reference: reversed.reference };
  },
});
