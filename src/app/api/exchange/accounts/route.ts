import { z } from 'zod';
import { route } from '@/core/http/route';
import { prisma } from '@/core/db/prisma';
import { accountStatement, trialBalance } from '@/modules/ledger/ledger.service';

const querySchema = z.object({
  view: z.enum(['list', 'trialBalance', 'statement']).default('list'),
  accountId: z.string().optional(),
  kind: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.account.view'],
  querySchema,
  handler: async ({ query }) => {
    if (query.view === 'trialBalance') {
      return trialBalance({ asOf: query.to });
    }

    if (query.view === 'statement') {
      if (!query.accountId) return { lines: [], total: 0, page: 1, pageSize: 50, pageCount: 1 };
      return accountStatement(query.accountId, {
        from: query.from,
        to: query.to,
        page: query.page,
        pageSize: query.pageSize,
      });
    }

    return prisma.account.findMany({
      where: {
        isActive: true,
        ...(query.kind ? { kind: { in: query.kind.split(',') } } : {}),
      },
      orderBy: [{ currencyCode: 'asc' }, { sortOrder: 'asc' }, { code: 'asc' }],
      include: { currency: { select: { nameEn: true, nameAr: true, decimals: true, symbol: true } } },
    });
  },
});
