import { z } from 'zod';
import { route } from '@/core/http/route';
import { deskDetail, markSent } from '@/modules/bank/bank.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** One transfer in full: the deal behind it, and the photos it carries. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  handler: async ({ params, actor }) => deskDetail(params.id, actor),
});

/** The bank's receipt for it, shrunk by the screen, as base64; optional. */
const bodySchema = z.object({ receipt: z.string().max(6_000_000).nullish() });

/** A transfer sent from the bank's app: the deal stops waiting. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => markSent(params.id, body.receipt ?? null, actor),
});
