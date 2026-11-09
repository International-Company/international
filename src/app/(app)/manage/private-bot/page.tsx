import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { PrivateBotTabs } from './private-bot-tabs';

export const metadata: Metadata = { title: 'Private number' };
export const dynamic = 'force-dynamic';

export default async function PrivateBotPage() {
  const session = await requirePagePermission('settings.view');
  const { t } = await getTranslator();

  return (
    <div className="space-y-4">
      <PageHeader title={t('privateBot.title')} description={t('privateBot.subtitle')} />
      <PrivateBotTabs canManage={session.user.permissions.includes('settings.manage')} />
    </div>
  );
}
