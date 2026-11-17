import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { describeAll } from '@/modules/settings/settings.service';
import { prisma } from '@/core/db/prisma';
import { PageHeader } from '@/ui/primitives';
import { SettingsView } from './settings-view';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await requirePagePermission('settings.view');
  const { t } = await getTranslator();

  // The bank desk is chosen from the staff: the list is theirs, read now.
  const staff = await prisma.user.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { fullNameAr: 'asc' },
    select: { id: true, fullNameAr: true, fullNameEn: true },
  });
  const settings = (await describeAll()).map((setting) =>
    setting.key === 'bank.executorId' || setting.key === 'treasury.supervisorId'
      ? {
          ...setting,
          options: [
            { value: '', labelAr: '— لا أحد —', labelEn: '— Nobody —' },
            ...staff.map((user) => ({
              value: user.id,
              labelAr: user.fullNameAr,
              labelEn: user.fullNameEn,
            })),
          ],
        }
      : setting,
  );

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
