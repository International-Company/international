import { z } from 'zod';
import { route } from '@/core/http/route';
import { addProof } from '@/modules/exchange/remittance.service';
import { PROOF_KINDS } from '@/modules/exchange/proof-image';

const paramsSchema = z.object({ id: z.string().min(1) });
// A photo the screen has already shrunk, as base64. The service checks what it is.
const bodySchema = z.object({
  image: z.string().min(1).max(6_000_000),
  kind: z.enum(PROOF_KINDS).default('PAYMENT'),
});

/** A photo attached after the remittance was recorded. */
export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  // The service asks for what the deal's own kind needs.
  permissions: ['exchange.transaction.view'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => addProof(params.id, body.image, actor, body.kind),
});
