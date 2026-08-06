import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { rateBoard, rateHistory } from '@/modules/exchange/rates.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { RatesView } from './rates-view';

export const metadata: Metadata = { title: 'Exchange rates' };
export const dynamic = 'force-dynamic';

export default async function RatesPage() {
  const session = await requirePermission('exchange.rate.view');
  const { t } = await getTranslator();

  const [board, history, currencies] = await Promise.all([
    rateBoard(),
    rateHistory({ limit: 60 }),
    prisma.currency.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true },
    }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('rates.title')} description={t('rates.subtitle')} />

      <RatesView
        board={toJsonSafe(board)}
        history={toJsonSafe(history)}
        currencies={currencies}
        canManage={session.user.permissions.includes('exchange.rate.manage')}
      />
    </div>
  );
}
