import { z } from 'zod';
import { route } from '@/core/http/route';
import { decideCount } from '@/modules/treasury/ewallet.service';

const paramsSchema = z.object({ id: z.string().min(1) });
const bodySchema = z.object({ confirm: z.boolean(), note: z.string().max(300).nullish() });

/** The manager's word on a wallet's count: confirmed, or returned to count again. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['treasury.handover.manage'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => decideCount(params.id, { confirm: body.confirm, note: body.note ?? null }, actor),
});
