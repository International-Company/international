import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { toJsonSafe } from '@/core/http/json';
import { readProofImage } from '@/modules/exchange/proof-image';
import {
  addReceiptByHand,
  collectReceipts,
  listReceipts,
  removeReceipt,
} from '@/modules/bank/bank-receipts.service';

const DESK = ['bank.execute', 'exchange.transfer.confirm'];
const kind = z.enum(['deal', 'request', 'tiktok']);
const which = z.object({ kind, id: z.string().min(1).max(40) });

/** Every receipt a transfer on the bank desk carries. */
export const GET = route<unknown, z.infer<typeof which>>({
  anyPermission: DESK,
  querySchema: which,
  handler: async ({ query }) => toJsonSafe(await listReceipts(query.kind, query.id)),
});

const bodySchema = z.discriminatedUnion('action', [
  /** One more, chosen or pasted at the desk, shrunk by the screen, as base64. */
  z.object({ action: z.literal('add'), kind, id: z.string().min(1).max(40), receipt: z.string().min(1).max(6_000_000), tell: z.boolean().optional() }),
  /** Looked for again in the groups it was answered in. */
  z.object({ action: z.literal('collect'), kind, id: z.string().min(1).max(40) }),
]);

export const POST = route<z.infer<typeof bodySchema>>({
  anyPermission: DESK,
  bodySchema,
  handler: async ({ body, actor }) => {
    if (body.action === 'collect') return toJsonSafe(await collectReceipts(body.kind, body.id, actor));
    const image = readProofImage(body.receipt);
    if (typeof image === 'string') throw errors.precondition('That photo cannot be kept', image);
    return toJsonSafe(await addReceiptByHand(body.kind, body.id, image, actor, { tell: body.tell }));
  },
});

const removeSchema = which.extend({ receiptId: z.string().min(1).max(80) });

/** One receipt taken off: the wrong photo. */
export const DELETE = route<unknown, z.infer<typeof removeSchema>>({
  anyPermission: DESK,
  querySchema: removeSchema,
  handler: async ({ query, actor }) => toJsonSafe(await removeReceipt(query.kind, query.id, query.receiptId, actor)),
});
