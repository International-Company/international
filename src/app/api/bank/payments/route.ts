import { z } from 'zod';
import { route } from '@/core/http/route';
import { toJsonSafe } from '@/core/http/json';
import { parseMoney } from '@/core/money/money';
import { editPayment, paymentSummary } from '@/modules/bank/transfer-payments.service';

const DESK = ['bank.execute', 'exchange.transfer.confirm'];
const which = z.object({ kind: z.enum(['deal', 'request', 'tiktok']), id: z.string().min(1).max(40) });

/** A transfer's parts: what each receipt shows was sent, and what is left. */
export const GET = route<unknown, z.infer<typeof which>>({
  anyPermission: DESK,
  querySchema: which,
  handler: async ({ query, actor }) => toJsonSafe(await paymentSummary(query.kind, query.id, actor)),
});

const editSchema = z.object({ paymentId: z.string().min(1).max(40), amount: z.string().max(30).nullable() });

/** A receipt's sum written by hand. */
export const PATCH = route<z.infer<typeof editSchema>>({
  anyPermission: DESK,
  bodySchema: editSchema,
  handler: async ({ body, actor }) =>
    toJsonSafe(await editPayment(body.paymentId, body.amount?.trim() ? parseMoney(body.amount) : null, actor)),
});
