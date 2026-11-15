import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { InboxView } from './inbox-view';

export const metadata: Metadata = { title: 'Customer WhatsApp' };
export const dynamic = 'force-dynamic';

export default async function InboxPage() {
  await requirePagePermission('customers.whatsapp');
  const { t } = await getTranslator();

  return (
    <div className="space-y-4">
      <PageHeader title={t('inbox.title')} description={t('inbox.subtitle')} />
      <InboxView />
    </div>
  );
}
