import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { WorkDaysView } from './work-days-view';

export const metadata: Metadata = { title: 'Work days' };
export const dynamic = 'force-dynamic';

/**
 * «أيام العمل» — the teller's days on the machine, one at a time, chosen from a
 * calendar: each day's figures and every exchange in it.
 *
 * Behind the machine's permission, because these are the machine's days.
 * `?date=YYYY-MM-DD` opens a given day, so a day can be reloaded or linked.
 */
export default async function WorkDaysPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  await requirePagePermission('exchange.machine.use');
  const { t } = await getTranslator();
  const { date } = await searchParams;
  const initialDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      <PageHeader title={t('ledgerDays.pageTitle')} description={t('ledgerDays.pageSubtitle')} />
      <WorkDaysView initialDate={initialDate} />
    </div>
  );
}
