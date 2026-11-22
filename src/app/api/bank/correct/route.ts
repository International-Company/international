import { z } from 'zod';
import { route } from '@/core/http/route';
import { reopenSent, replaceReceipt } from '@/modules/bank/bank-correction.service';

const bodySchema = z.discriminatedUnion('action', [
  /** Marked sent by mistake: back to waiting. */
  z.object({ action: z.literal('reopen'), kind: z.enum(['deal', 'request', 'tiktok']), id: z.string().min(1).max(40) }),
  /** The receipt replaced with the right one, shrunk by the screen, as base64. */
  z.object({
    action: z.literal('receipt'),
    kind: z.enum(['deal', 'request', 'tiktok']),
    id: z.string().min(1).max(40),
    receipt: z.string().min(1).max(6_000_000),
  }),
]);

/** A transfer on the bank desk put right after it was marked sent. */
export const POST = route<z.infer<typeof bodySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  bodySchema,
  handler: async ({ body, actor, session }) => {
    const who = { ...actor, name: session.user.fullNameAr || actor.name };
    return body.action === 'reopen'
      ? reopenSent(body.kind, body.id, who)
      : replaceReceipt(body.kind, body.id, body.receipt, who);
  },
});
