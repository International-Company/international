import { z } from 'zod';
import { route } from '@/core/http/route';
import { createWallet, listWallets, portfolio } from '@/modules/usdt/wallet.service';
import { availableNetworks } from '@/modules/usdt/providers';

const querySchema = z.object({
  includeInactive: z.coerce.boolean().default(false),
  withPortfolio: z.coerce.boolean().default(false),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['usdt.wallet.view'],
  querySchema,
  handler: async ({ query }) => {
    const wallets = await listWallets({ includeInactive: query.includeInactive });

    return {
      wallets,
      networks: availableNetworks(),
      ...(query.withPortfolio ? { portfolio: await portfolio() } : {}),
    };
  },
});

const createSchema = z.object({
  label: z.string().min(1).max(120),
  labelAr: z.string().min(1).max(120),
  network: z.enum(['TRON', 'ETHEREUM', 'BSC', 'BINANCE', 'MANUAL']),
  // A Binance ID is shorter than any chain address; each network checks its own.
  address: z.string().min(6).max(120),
  contractAddress: z.string().max(120).nullable().optional(),
  tokenSymbol: z.string().max(12).default('USDT'),
  isWatchOnly: z.boolean().default(true),
  minConfirmations: z.number().int().min(1).max(200).default(19),
  notifyOnIncoming: z.boolean().default(true),
  notifyOnOutgoing: z.boolean().default(true),
  autoCreateTransaction: z.boolean().default(true),
  /** A Binance wallet's read-only key. Required for one, refused for any other. */
  apiKey: z.string().max(200).nullish(),
  apiSecret: z.string().max(200).nullish(),
});

export const POST = route<z.infer<typeof createSchema>>({
  permissions: ['usdt.wallet.manage'],
  bodySchema: createSchema,
  handler: async ({ body, actor }) => createWallet(body, actor),
});
