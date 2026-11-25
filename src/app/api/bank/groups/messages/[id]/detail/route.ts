import { z } from 'zod';
import { route } from '@/core/http/route';
import { toJsonSafe } from '@/core/http/json';
import { messageDetail, readMessage } from '@/modules/bank/message-detail.service';

const paramsSchema = z.object({ id: z.string().min(1) });
const DESK = ['bank.execute', 'exchange.transfer.confirm'];

/** A group's message in full: its photo read, the transfer it is or answers, and what it replies to. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: DESK,
  paramsSchema,
  handler: async ({ params, actor }) => toJsonSafe(await messageDetail(params.id, actor)),
});

const bodySchema = z.object({ again: z.boolean().optional() });

/** Its photo read field by field — once, unless asked to read it again. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: DESK,
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => readMessage(params.id, actor, body.again === true),
});
