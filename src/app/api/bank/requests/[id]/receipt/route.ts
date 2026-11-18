import { z } from 'zod';
import { route } from '@/core/http/route';
import { requestReceipt } from '@/modules/bank/bank-request.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** The bank's receipt for a request from a group. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    const file = await requestReceipt(params.id, actor);
    return new Response(new Uint8Array(file.data), {
      headers: { 'content-type': file.mimeType, 'cache-control': 'private, max-age=3600' },
    });
  },
});
