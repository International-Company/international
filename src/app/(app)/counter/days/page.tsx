import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { DailyLedger } from '@/app/_activity/daily-ledger';

export const metadata: Metadata = { title: 'Work days' };
export const dynamic = 'force-dynamic';

/**
 * «أيام العمل» — the teller's days on the machine, a screen of their own.
 *
 * Each day is its own account: what was exchanged, what of its transfers was
 * still owed when it ended, and — tapped open — every exchange behind it.
 * Behind the machine's permission, because these are the machine's days.
 */
export default async function WorkDaysPage() {
  await requirePagePermission('exchange.machine.use');
  const { t } = await getTranslator();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4">
      <PageHeader title={t('ledgerDays.pageTitle')} description={t('ledgerDays.pageSubtitle')} />
      <DailyLedger days={30} />
    </div>
  );
}
