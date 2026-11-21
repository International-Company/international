import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import {
  decideNotice,
  NETWORKS,
  noticeDetail,
  reopenNotice,
  sendForCheck,
  updateNotice,
} from '@/modules/whatsapp/remittance-notice.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** One notice, with what its agent has said so far. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  handler: async ({ params, actor }) => noticeDetail(actor.id, params.id),
});

const patchSchema = z.object({
  network: z.enum(NETWORKS).optional(),
  amount: z.string().max(30).nullish(),
  currency: z.string().max(8).nullish(),
  note: z.string().max(500).nullish(),
});

/** What the teller read off the notice. */
export const PATCH = route<z.infer<typeof patchSchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  bodySchema: patchSchema,
  handler: async ({ params, body, actor }) =>
    updateNotice(actor.id, params.id, {
      network: body.network,
      amount:
        body.amount === undefined ? undefined : body.amount?.trim() ? parseMoney(body.amount) : null,
      currency: body.currency,
      note: body.note,
    }),
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('send'), agentChat: z.string().min(5).max(120) }),
  z.object({ action: z.literal('decide'), decision: z.enum(['CONFIRMED', 'REJECTED']) }),
  z.object({ action: z.literal('reopen') }),
]);

/** Sent to the agent for checking, decided, or opened again. */
export const POST = route<z.infer<typeof actionSchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp'],
  paramsSchema,
  bodySchema: actionSchema,
  handler: async ({ params, body, actor, session }) => {
    if (body.action === 'send') return sendForCheck(actor.id, params.id, body.agentChat);
    if (body.action === 'decide') {
      return decideNotice(actor.id, params.id, body.decision, session.user.fullNameAr || actor.name);
    }
    return reopenNotice(actor.id, params.id);
  },
});
