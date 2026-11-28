import { z } from 'zod';
import { route } from '@/core/http/route';
import { listWallets, openWallet, pendingCounts } from '@/modules/treasury/ewallet.service';

/** Every teller's e-wallet, and the counts waiting on the manager. */
export const GET = route({
  permissions: ['treasury.handover.manage'],
  handler: async () => {
    const [wallets, counts] = await Promise.all([listWallets(), pendingCounts()]);
    return { wallets, counts };
  },
});

const bodySchema = z.object({
  tellerId: z.string().min(1),
  label: z.string().max(40).nullish(),
});

/** A wallet opened for a teller. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['treasury.handover.manage'],
  bodySchema,
  handler: async ({ body, actor }) => openWallet(body.tellerId, body.label ?? null, actor),
});
