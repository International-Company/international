import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { WithdrawalsView } from './withdrawals-view';

export const metadata: Metadata = { title: 'USDT sends' };
export const dynamic = 'force-dynamic';

/**
 * Where a manager releases coins, or refuses to.
 *
 * Behind the releasing permission alone. A teller who may only record a sale
 * has nothing to do here, and a queue of everybody's waiting sends is not a
 * thing to leave open on a counter screen.
 */
export default async function WithdrawalsPage() {
  await requirePagePermission('usdt.withdrawal.approve');
  const { t } = await getTranslator();

  return (
    <div className="space-y-4">
      <PageHeader title={t('release.title')} description={t('release.subtitle')} />
      <WithdrawalsView />
    </div>
  );
}
