import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import { getWallet, setBalance, updateWallet } from '@/modules/usdt/wallet.service';
import { syncWallet } from '@/modules/usdt/sync.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['usdt.wallet.view'],
  paramsSchema,
  handler: async ({ params }) => getWallet(params.id),
});

const patchSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  labelAr: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  isWatchOnly: z.boolean().optional(),
  minConfirmations: z.number().int().min(1).max(200).optional(),
  notifyOnIncoming: z.boolean().optional(),
  notifyOnOutgoing: z.boolean().optional(),
  autoCreateTransaction: z.boolean().optional(),
});

export const PATCH = route<z.infer<typeof patchSchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['usdt.wallet.manage'],
  paramsSchema,
  bodySchema: patchSchema,
  handler: async ({ params, body, actor }) => updateWallet(params.id, body, actor),
});

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sync'), deep: z.boolean().default(false) }),
  z.object({ action: z.literal('setBalance'), balance: z.string().or(z.number()) }),
]);

export const POST = route<z.infer<typeof actionSchema>, unknown, z.infer<typeof paramsSchema>>({
  paramsSchema,
  bodySchema: actionSchema,
  rateLimit: { key: 'wallet-action', limit: 30, windowSeconds: 300 },
  handler: async ({ params, body, actor }) => {
    if (body.action === 'sync') {
      if (!actor.permissions.includes('usdt.wallet.sync')) {
        throw errors.forbidden('usdt.wallet.sync');
      }
      return syncWallet(params.id, { actorId: actor.id, deep: body.deep });
    }

    if (!actor.permissions.includes('usdt.wallet.manage')) {
      throw errors.forbidden('usdt.wallet.manage');
    }
    await setBalance(params.id, parseMoney(body.balance), actor);
    return { ok: true };
  },
});
