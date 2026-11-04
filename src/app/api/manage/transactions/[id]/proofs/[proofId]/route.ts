import { z } from 'zod';
import { route } from '@/core/http/route';
import { readProof } from '@/modules/exchange/remittance.service';

const paramsSchema = z.object({ id: z.string().min(1), proofId: z.string().min(1) });

/** One photo, to whoever can read the deal it belongs to. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.transaction.view'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    const proof = await readProof(params.id, params.proofId, actor);
    return new Response(new Uint8Array(proof.data), {
      headers: {
        'content-type': proof.mimeType,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  },
});
