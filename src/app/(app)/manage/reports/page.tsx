import type { Metadata } from 'next';
import { requireActiveSession } from '@/modules/auth/context';
import { redirect } from 'next/navigation';
import { getTranslator } from '@/i18n/server';
import { availableTo } from '@/modules/reports/report.service';
import { PageHeader } from '@/ui/primitives';
import { ReportsView } from './reports-view';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

/**
 * The office's figures, on paper or in a spreadsheet.
 *
 * There is no single "may run reports" permission: each report carries the one
 * its own data needs, and this screen offers only what the person holds. So
 * somebody who may read the transactions but not the ledger sees one report
 * here rather than a list of locked doors.
 */
export default async function ReportsPage() {
  const session = await requireActiveSession();
  const { t } = await getTranslator();

  const available = availableTo(session.user.permissions).map((report) => ({
    key: report.key,
    nameEn: report.nameEn,
    nameAr: report.nameAr,
  }));

  // Nothing to offer is not an empty screen — it is the wrong screen for them.
  if (available.length === 0) redirect('/no-access?need=ledger.view');

  return (
    <div className="space-y-4">
      <PageHeader title={t('reports.title')} description={t('reports.subtitle')} />
      <ReportsView available={available} />
    </div>
  );
}
