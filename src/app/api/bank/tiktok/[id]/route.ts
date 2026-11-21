import { z } from 'zod';
import { route } from '@/core/http/route';
import { markTiktokSent, tiktokDetail } from '@/modules/bank/bank-tiktok.service';

const paramsSchema = z.object({ id: z.string().min(1) });
const DESK = ['bank.execute', 'exchange.transfer.confirm'];

/** A TikTok withdrawal in full, for the bank desk. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: DESK,
  paramsSchema,
  handler: async ({ params, actor }) => tiktokDetail(params.id, actor),
});

const bodySchema = z.object({ receipt: z.string().max(6_000_000).nullish() });

/** Its transfer sent from the bank, with the receipt when there is one. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: DESK,
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => markTiktokSent(params.id, body.receipt ?? null, actor),
});
