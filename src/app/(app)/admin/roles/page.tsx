import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { listRoles } from '@/modules/users/users.service';
import { MODULE_LABELS, PERMISSIONS } from '@/core/security/permissions';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { RolesView } from './roles-view';

export const metadata: Metadata = { title: 'Roles & permissions' };
export const dynamic = 'force-dynamic';

export default async function RolesPage() {
  const session = await requirePermission('users.roles.manage');
  const { t } = await getTranslator();

  const roles = await listRoles();

  return (
    <div className="space-y-4">
      <PageHeader title={t('roles.title')} description={t('roles.subtitle')} />

      <RolesView
        roles={toJsonSafe(roles)}
        permissions={PERMISSIONS}
        moduleLabels={MODULE_LABELS}
        grantable={session.user.permissions}
      />
    </div>
  );
}
