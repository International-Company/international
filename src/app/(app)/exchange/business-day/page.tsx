import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { closingSheet, getCurrentDay, listDays } from '@/modules/exchange/business-day.service';
import { toJsonSafe } from '@/core/http/json';
import { Alert, PageHeader } from '@/ui/primitives';
import { BusinessDayView } from './business-day-view';

export const metadata: Metadata = { title: 'Daily closing' };
export const dynamic = 'force-dynamic';

export default async function BusinessDayPage() {
  const session = await requirePermission('exchange.day.view');
  const { t } = await getTranslator();

  const branch =
    (session.user.branchId
      ? await prisma.branch.findUnique({ where: { id: session.user.branchId } })
      : null) ??
    (await prisma.branch.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } }));

  if (!branch) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('businessDay.title')} />
        <Alert tone="danger">{t('errors.preconditionFailed')}</Alert>
      </div>
    );
  }

  const [day, sheet, history] = await Promise.all([
    getCurrentDay(branch.id),
    closingSheet(branch.id, new Date()),
    listDays(branch.id, { limit: 30 }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('businessDay.title')} description={t('businessDay.subtitle')} />

      <BusinessDayView
        branch={{ id: branch.id, nameEn: branch.nameEn, nameAr: branch.nameAr }}
        day={day ? toJsonSafe(day) : null}
        sheet={toJsonSafe(sheet)}
        history={toJsonSafe(history)}
        permissions={session.user.permissions}
      />
    </div>
  );
}
