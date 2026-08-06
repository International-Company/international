import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { inbox } from '@/modules/notifications/notifications.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { NotificationsView } from './notifications-view';

export const metadata: Metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const session = await requirePermission('notifications.view');
  const { t } = await getTranslator();

  const initial = await inbox({ userId: session.user.id, pageSize: 25 });

  return (
    <div className="space-y-4">
      <PageHeader title={t('notifications.title')} description={t('notifications.subtitle')} />
      <NotificationsView initial={toJsonSafe(initial)} />
    </div>
  );
}
