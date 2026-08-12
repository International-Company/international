import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { ExceptionsView } from './exceptions-view';

export const metadata: Metadata = { title: 'Broken prices' };
export const dynamic = 'force-dynamic';

/**
 * Where a manager answers a teller who has a customer waiting.
 *
 * Behind the approving permission alone. Somebody who may only ask should not
 * be reading the queue of everyone else's asks, and there is nothing here for
 * them to do.
 */
export default async function ExceptionsPage() {
  await requirePermission('exchange.priceException.approve');
  const { t } = await getTranslator();

  return (
    <div className="space-y-4">
      <PageHeader title={t('exception.title')} description={t('exception.subtitle')} />
      <ExceptionsView />
    </div>
  );
}
