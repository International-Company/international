import { z } from 'zod';
import { route } from '@/core/http/route';
import { heldByWallets, walletChoices } from '@/modules/treasury/ewallet.service';

const querySchema = z.object({ refs: z.string().max(4000).optional() });

/** The wallets a transfer may be handed to, and which of these transfers one holds already. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm', 'treasury.handover.manage'],
  querySchema,
  handler: async ({ query }) => {
    const refs = (query.refs ?? '').split(',').filter(Boolean).slice(0, 300);
    const [wallets, held] = await Promise.all([walletChoices(), heldByWallets(refs)]);
    return { wallets, held };
  },
});
