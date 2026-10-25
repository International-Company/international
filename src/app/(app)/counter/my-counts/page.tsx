import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requirePageAnyPermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { MyCountsView } from './my-counts-view';

export const metadata: Metadata = { title: 'My till counts' };
export const dynamic = 'force-dynamic';

/**
 * A teller's own till counts, after the fact. They see what each count found
 * once it is saved — never what their drawer should hold beforehand, which is
 * what keeps the count worth taking.
 */
export default async function MyCountsPage() {
  await requirePageAnyPermission('exchange.machine.use', 'exchange.transaction.create');
  const { t } = await getTranslator();

  const currencies = await prisma.currency.findMany({ select: { code: true, decimals: true } });

  return (
    <div className="space-y-4">
      <PageHeader title={t('till.mine')} description={t('till.mineHint')} />
      <MyCountsView currencies={currencies} />
    </div>
  );
}
