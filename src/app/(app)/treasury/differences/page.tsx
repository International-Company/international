import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { DifferencesView } from './differences-view';

export const metadata: Metadata = { title: 'Differences' };
export const dynamic = 'force-dynamic';

/**
 * The manager's screen for the differences balance.
 *
 * Every gap the evening count found, and nothing else.
 *
 * Behind `ledger.view` rather than the handover permission: a difference is a
 * question about what the office is worth, and the person who answers it is the
 * person who reads the position. Ruling on one is checked again in the service,
 * where the manager's permission is required.
 */
export default async function DifferencesPage() {
  await requirePagePermission('ledger.view');
  const { t } = await getTranslator();

  return (
    <div className="space-y-4">
      <PageHeader title={t('difference.title')} description={t('difference.subtitle')} />
      <DifferencesView />
    </div>
  );
}
