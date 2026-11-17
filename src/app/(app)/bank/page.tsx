import type { Metadata } from 'next';
import { requirePageAnyPermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { BankView } from './bank-view';
import { GroupFeed } from './group-feed';

export const metadata: Metadata = { title: 'Bank' };
export const dynamic = 'force-dynamic';

/** The bank desk: the transfers deals promised, sent one by one from the office's accounts. */
export default async function BankPage() {
  await requirePageAnyPermission('bank.execute', 'exchange.transfer.confirm');
  const { t } = await getTranslator();
  return (
    <div className="space-y-4">
      <PageHeader title={t('bank.title')} description={t('bank.subtitle')} />
      {/* The transfers to send, and beside them the groups they travel through. */}
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_28rem]">
        <BankView />
        <GroupFeed />
      </div>
    </div>
  );
}
