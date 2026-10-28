import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { DailyCountView } from './daily-count-view';

export const metadata: Metadata = { title: 'Daily count' };
export const dynamic = 'force-dynamic';

/**
 * «الجرد اليومي» — the teller's day sorted by kind: USDT received, USDT sent,
 * bought, sold, each with its totals and its deals beneath.
 *
 * Behind `exchange.transaction.view`, which means "may see his own
 * transactions"; everything here is the signed-in person's own.
 */
export default async function DailyCountPage() {
  await requirePagePermission('exchange.transaction.view');
  const { t } = await getTranslator();

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <PageHeader title={t('dailyCount.title')} description={t('dailyCount.subtitle')} />
      <DailyCountView />
    </div>
  );
}
