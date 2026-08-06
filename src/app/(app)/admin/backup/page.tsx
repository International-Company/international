import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { listBackups } from '@/modules/backup/backup.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { BackupView } from './backup-view';

export const metadata: Metadata = { title: 'Backup & restore' };
export const dynamic = 'force-dynamic';

export default async function BackupPage() {
  const session = await requirePermission('system.backup.view');
  const { t } = await getTranslator();

  const backups = await listBackups();

  return (
    <div className="space-y-4">
      <PageHeader title={t('backup.title')} description={t('backup.subtitle')} />
      <BackupView backups={toJsonSafe(backups)} permissions={session.user.permissions} />
    </div>
  );
}
