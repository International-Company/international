import { z } from 'zod';
import { route } from '@/core/http/route';
import { findByHash } from '@/modules/usdt/sync.service';

const bodySchema = z.object({
  /** The hash the customer sends, or an explorer link carrying it. */
  txHash: z.string().trim().min(6).max(300),
});

/**
 * A transfer named by its hash: asked of the chain at once and written down,
 * so the teller need not wait for the address to be read — however old it is.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['usdt.counter.use'],
  bodySchema,
  handler: async ({ body }) => ({ ids: await findByHash(body.txHash) }),
});
