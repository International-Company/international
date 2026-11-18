import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { dismiss, editRequest, markRequestSent, requestDetail } from '@/modules/bank/bank-request.service';
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

const editSchema = z.object({
  account: z.string().min(1).max(60),
  name: z.string().max(120).nullish(),
  channel: z.string().max(80).nullish(),
  amount: z.string().min(1).max(30),
  currency: z.string().min(3).max(8).default('ILS'),
});

/** What the bot read, corrected by hand while it waits. */
export const PATCH = route<z.infer<typeof editSchema>, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: DESK,
  paramsSchema,
  bodySchema: editSchema,
  handler: async ({ params, body, actor }) =>
    editRequest(
      params.id,
      {
        account: body.account,
        name: body.name ?? null,
        channel: body.channel ?? null,
        amount: parseMoney(body.amount),
        currency: body.currency.toUpperCase(),
      },
      actor,
    ),
});

/** Not the desk's: off the list, the group told nothing. */
export const DELETE = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: DESK,
  paramsSchema,
  handler: async ({ params, actor }) => dismiss(params.id, actor),
});
