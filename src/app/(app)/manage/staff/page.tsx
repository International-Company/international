import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { listUsers } from '@/modules/users/users.service';
import { prisma } from '@/core/db/prisma';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { UsersView } from './users-view';

export const metadata: Metadata = { title: 'Users' };
export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const session = await requirePermission('users.view');
  const { t } = await getTranslator();

  const [users, roles, branches] = await Promise.all([
    listUsers({ pageSize: 50 }),
    prisma.role.findMany({
      where: { isActive: true },
      orderBy: { level: 'asc' },
      select: { id: true, key: true, nameEn: true, nameAr: true, level: true },
    }),
    prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, nameEn: true, nameAr: true },
    }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('users.title')} description={t('users.subtitle')} />

      <UsersView
        initial={toJsonSafe(users)}
        roles={roles}
        branches={branches}
        permissions={session.user.permissions}
      />
    </div>
  );
}
