import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { getCurrentDay, listDays } from '@/modules/exchange/business-day.service';
import { todaySummary } from '@/modules/exchange/transaction.service';
import { toJsonSafe } from '@/core/http/json';
import { Alert, PageHeader } from '@/ui/primitives';
import { DayView } from './day-view';

export const metadata: Metadata = { title: 'The counter day' };
export const dynamic = 'force-dynamic';

export default async function DayPage() {
  const session = await requirePagePermission('exchange.day.view');
  const { t } = await getTranslator();

  const branch = await prisma.branch.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } });
  if (!branch) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('day.title')} description={t('day.subtitle')} />
        <Alert tone="danger">{t('errors.noBranch')}</Alert>
      </div>
    );
  }

  const [current, recent, summary] = await Promise.all([
    getCurrentDay(branch.id),
    listDays(branch.id, 14),
    todaySummary(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('day.title')} description={t('day.subtitle')} />

      <DayView
        current={toJsonSafe(current)}
        recent={toJsonSafe(recent)}
        summary={toJsonSafe(summary)}
        permissions={session.user.permissions}
      />
    </div>
  );
}
