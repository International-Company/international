import { z } from 'zod';
import { route } from '@/core/http/route';
import { dismiss, markRequestSent, requestDetail } from '@/modules/bank/bank-request.service';
import { watched } from '@/modules/bank/group-feed.service';

const paramsSchema = z.object({ id: z.string().min(1) });
const DESK = ['bank.execute', 'exchange.transfer.confirm'];

/** One request in full: the message it was read from, and what was taken from it. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: DESK,
  paramsSchema,
  handler: async ({ params, actor }) => {
    const groups = await watched();
    return requestDetail(params.id, actor, (chat) => groups.find((group) => group.id === chat)?.name ?? null);
  },
});

const bodySchema = z.object({ receipt: z.string().max(6_000_000).nullish() });

/** Sent from the bank: the bot answers the message it came from in the group. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: DESK,
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => markRequestSent(params.id, body.receipt ?? null, actor),
});

/** Not the desk's: off the list, the group told nothing. */
export const DELETE = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: DESK,
  paramsSchema,
  handler: async ({ params, actor }) => dismiss(params.id, actor),
});
