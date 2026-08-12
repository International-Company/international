import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { brokerActivity } from '@/modules/drawers/drawer.service';
import { transferChannels } from '@/modules/exchange/machine.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { BrokerView } from './broker-view';

export const metadata: Metadata = { title: 'Broker' };
export const dynamic = 'force-dynamic';

/**
 * Checking the broker's statement.
 *
 * The office keeps no books per account — its claim is on the broker, not on
 * any one of his accounts — so this is not a set of balances to be trusted. It
 * is the other half of a conversation: he sends a statement saying an account
 * moved a certain amount, and this says what the branch instructed through it.
 * Two figures to compare, and the movements behind them when they disagree.
 */
export default async function BrokerPage() {
  await requirePagePermission('exchange.drawer.view');
  const { t } = await getTranslator();

  // A month back: long enough to cover a statement cycle, short enough that the
  // page is a working document rather than an archive.
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const [activity, accounts] = await Promise.all([
    brokerActivity({ from: since }),
    transferChannels(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('broker.title')} description={t('broker.subtitle')} />

      <BrokerView
        activity={toJsonSafe(activity)}
        accounts={accounts}
        since={since.toISOString()}
      />
    </div>
  );
}
