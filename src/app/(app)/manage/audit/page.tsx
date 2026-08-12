import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { query } from '@/modules/audit/audit.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { AuditView } from './audit-view';

export const metadata: Metadata = { title: 'Audit log' };
export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const session = await requirePagePermission('audit.view');
  const { t } = await getTranslator();

  const initial = await query({ pageSize: 50 });

  return (
    <div className="space-y-4">
      <PageHeader title={t('audit.title')} description={t('audit.subtitle')} />

      <AuditView
        initial={toJsonSafe(initial)}
        canVerify={session.user.permissions.includes('audit.verify')}
      />
    </div>
  );
}
