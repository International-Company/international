import { z } from 'zod';
import { route } from '@/core/http/route';
import { deskProof } from '@/modules/bank/bank.service';

const paramsSchema = z.object({ id: z.string().min(1), proofId: z.string().min(1) });

/** A photo a transfer's deal carries — the notice, the receipt — to the bank desk. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  paramsSchema,
  handler: async ({ params, actor }) => {
    const proof = await deskProof(params.id, params.proofId, actor);
    return new Response(new Uint8Array(proof.data), {
      headers: {
        'content-type': proof.mimeType,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  },
});
