import type { Metadata } from 'next';
import { requireAnyPermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { REPORTS } from '@/modules/reports/reports.service';
import { PageHeader } from '@/ui/primitives';
import { ReportsView } from './reports-view';

export const metadata: Metadata = { title: 'Reports' };

export default async function ReportsPage() {
  const session = await requireAnyPermission('reports.view', 'reports.financial.view');
  const { t } = await getTranslator();

  // Only offer reports the caller can actually run.
  const available = REPORTS.filter((report) =>
    session.user.permissions.includes(report.permission),
  ).map((report) => report.key);

  return (
    <div className="space-y-4">
      <PageHeader title={t('reports.title')} description={t('reports.subtitle')} />

      <ReportsView available={available} canExport={session.user.permissions.includes('reports.export')} />
    </div>
  );
}
