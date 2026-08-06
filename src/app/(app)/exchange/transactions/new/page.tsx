import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { prisma } from '@/core/db/prisma';
import { toJsonSafe } from '@/core/http/json';
import { NewTransactionForm } from './new-transaction-form';

export const metadata: Metadata = { title: 'New transaction' };
export const dynamic = 'force-dynamic';

export default async function NewTransactionPage() {
  const session = await requirePermission('exchange.transaction.create');

  // Currencies and cash accounts are small, stable reference data — fetching
  // them on the server saves the form two round trips before it is usable.
  const [currencies, accounts] = await Promise.all([
    prisma.currency.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true, decimals: true, kind: true },
    }),
    prisma.account.findMany({
      where: { isActive: true, kind: { in: ['CASH', 'BANK', 'CRYPTO'] } },
      orderBy: [{ currencyCode: 'asc' }, { sortOrder: 'asc' }],
      select: {
        id: true,
        code: true,
        nameEn: true,
        nameAr: true,
        currencyCode: true,
        kind: true,
        balance: true,
      },
    }),
  ]);

  return (
    <NewTransactionForm
      currencies={toJsonSafe(currencies)}
      accounts={toJsonSafe(accounts)}
      permissions={session.user.permissions}
    />
  );
}
