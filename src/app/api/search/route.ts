import { z } from 'zod';
import { route } from '@/core/http/route';
import { prisma } from '@/core/db/prisma';
import { containsInsensitive } from '@/core/db/search';

/**
 * Global search behind the command palette.
 *
 * Each source is queried only if the caller may see it, so search results can
 * never leak the existence of a record the user has no right to open. Results
 * are deliberately shallow — this is a navigation aid, not a report.
 */

const querySchema = z.object({
  q: z.string().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});

interface SearchResult {
  id: string;
  group: 'transactions' | 'customers' | 'wallets';
  title: string;
  subtitle?: string;
  href: string;
  icon: string;
}

export const GET = route<unknown, z.infer<typeof querySchema>>({
  querySchema,
  rateLimit: { key: 'search', limit: 120, windowSeconds: 60 },
  handler: async ({ query, actor }) => {
    const term = query.q.trim();
    const can = (permission: string) => actor.permissions.includes(permission);
    const results: SearchResult[] = [];

    if (can('exchange.transaction.view')) {
      const transactions = await prisma.transaction.findMany({
        where: {
          // Without `viewAll` a user searches only their own work.
          ...(can('exchange.transaction.viewAll') ? {} : { createdById: actor.id }),
          OR: [
            { reference: containsInsensitive(term) },
            { counterpartyName: containsInsensitive(term) },
            { counterpartyPhone: containsInsensitive(term) },
          ],
        },
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          reference: true,
          type: true,
          status: true,
          fromCurrency: true,
          customer: { select: { fullNameEn: true, fullNameAr: true } },
        },
      });

      results.push(
        ...transactions.map((transaction) => ({
          id: transaction.id,
          group: 'transactions' as const,
          title: transaction.reference,
          subtitle: `${transaction.type} · ${transaction.status} · ${transaction.customer?.fullNameEn ?? ''}`.trim(),
          href: `/manage/transactions/${transaction.id}`,
          icon: 'transactions',
        })),
      );
    }

    if (can('customers.view')) {
      const customers = await prisma.customer.findMany({
        where: {
          OR: [
            { code: containsInsensitive(term) },
            { fullNameEn: containsInsensitive(term) },
            { fullNameAr: containsInsensitive(term) },
            { phone: containsInsensitive(term) },
            { nationalId: containsInsensitive(term) },
          ],
        },
        take: query.limit,
        select: { id: true, code: true, fullNameEn: true, fullNameAr: true, phone: true },
      });

      results.push(
        ...customers.map((customer) => ({
          id: customer.id,
          group: 'customers' as const,
          title: customer.fullNameEn,
          subtitle: `${customer.code}${customer.phone ? ` · ${customer.phone}` : ''}`,
          href: `/manage/transactions?search=${customer.code}`,
          icon: 'customers',
        })),
      );
    }

    if (can('usdt.wallet.view')) {
      const wallets = await prisma.wallet.findMany({
        where: {
          OR: [
            { label: containsInsensitive(term) },
            { labelAr: containsInsensitive(term) },
            { address: containsInsensitive(term) },
          ],
        },
        take: query.limit,
        select: { id: true, label: true, network: true, address: true },
      });

      results.push(
        ...wallets.map((wallet) => ({
          id: wallet.id,
          group: 'wallets' as const,
          title: wallet.label,
          subtitle: `${wallet.network} · ${wallet.address.slice(0, 12)}…`,
          href: `/manage/usdt`,
          icon: 'wallet',
        })),
      );
    }

    return results;
  },
});
