import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { describeAll } from '@/modules/settings/settings.service';
import { PageHeader } from '@/ui/primitives';
import { SettingsView } from './settings-view';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requirePagePermission('settings.view');
  const { t } = await getTranslator();

  const settings = await describeAll();

  return (
    <div className="space-y-4">
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />

      <SettingsView
        settings={settings}
        canManage={session.user.permissions.includes('settings.manage')}
      />
    </div>
  );
}
