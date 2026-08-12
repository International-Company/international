import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { baseCurrency } from '@/modules/ledger/cutoff.service';
import { PageHeader } from '@/ui/primitives';
import { TellersView } from './tellers-view';

export const metadata: Metadata = { title: 'Tellers' };
export const dynamic = 'force-dynamic';

/**
 * Judging the people at the counter, on more than the number they produce.
 *
 * Behind `ledger.view` because that is the permission that means "reads what
 * the office is worth" — and what a teller gave it is the same question asked
 * one person at a time.
 */
export default async function TellersPage() {
  await requirePagePermission('ledger.view');
  const { t } = await getTranslator();

  return (
    <div className="space-y-4">
      <PageHeader title={t('evaluation.title')} description={t('evaluation.subtitle')} />
      <TellersView base={await baseCurrency()} />
    </div>
  );
}
