import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { TillCountsView } from './till-counts-view';

export const metadata: Metadata = { title: 'Till counts' };
export const dynamic = 'force-dynamic';

/**
 * جرد الصناديق — each teller counted against what they traded, with no float
 * handed over in the morning. For whoever counts; never the teller themselves.
 */
export default async function TillCountsPage() {
  const session = await requirePagePermission('treasury.handover.manage');
  const { t } = await getTranslator();

  const [tellers, currencies] = await Promise.all([
    // Anybody who records deals at a counter, other than the person counting.
    prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        id: { not: session.user.id },
        OR: [
          {
            roles: {
              some: {
                role: { permissions: { some: { permission: { key: 'exchange.machine.use' } } } },
              },
            },
          },
          {
            permissions: { some: { permission: { key: 'exchange.machine.use' }, effect: 'ALLOW' } },
          },
          {
            roles: {
              some: {
                role: {
                  permissions: { some: { permission: { key: 'exchange.transaction.create' } } },
                },
              },
            },
          },
          {
            permissions: {
              some: { permission: { key: 'exchange.transaction.create' }, effect: 'ALLOW' },
            },
          },
        ],
      },
      select: { id: true, fullNameEn: true, fullNameAr: true },
      orderBy: { fullNameAr: 'asc' },
    }),
    // Notes only: a balance in USDT is never in anybody's drawer.
    prisma.currency.findMany({
      where: { isActive: true, kind: { not: 'CRYPTO' } },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true, decimals: true },
    }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('till.title')} description={t('till.subtitle')} />
      <TillCountsView tellers={tellers} currencies={currencies} />
    </div>
  );
}
