import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PERMISSIONS, MODULES, MODULE_LABELS } from '@/core/security/permissions';
import { PageHeader } from '@/ui/primitives';
import { PermissionsView } from './permissions-view';

export const metadata: Metadata = { title: 'Who may do what' };
export const dynamic = 'force-dynamic';

/**
 * صلاحيات التلر — what each person may do, one person at a time.
 *
 * The office does not run on one teller role. One does no remittances, one does
 * not sell USDT, one has a lower ceiling — and the engine has always been able
 * to express that, with a per-user allow/deny on top of the role and deny
 * winning. What was missing was somewhere to say it, which meant in practice it
 * could only be said by editing the database.
 *
 * The catalogue and what each role grants are read on the server and handed
 * down whole: they change when the code changes, not while a manager is looking
 * at the screen, so re-fetching them would be asking a question with a known
 * answer.
 */
export default async function PermissionsPage() {
  const session = await requirePagePermission('users.roles.assign');
  const { t } = await getTranslator();

  const [people, roles] = await Promise.all([
    prisma.user.findMany({
      where: { isSystem: false, status: { not: 'DISABLED' } },
      orderBy: [{ fullNameAr: 'asc' }],
      select: {
        id: true,
        username: true,
        fullNameEn: true,
        fullNameAr: true,
        jobTitleEn: true,
        jobTitleAr: true,
        status: true,
        counterLimit: true,
        roles: { select: { role: { select: { key: true, nameEn: true, nameAr: true, level: true } } } },
        permissions: { select: { effect: true, permission: { select: { key: true } } } },
      },
    }),
    prisma.role.findMany({
      where: { isActive: true },
      select: {
        key: true,
        level: true,
        permissions: { select: { permission: { select: { key: true } } } },
      },
    }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('access.title')} description={t('access.subtitle')} />

      <PermissionsView
        people={people.map((person) => ({
          id: person.id,
          username: person.username,
          fullNameEn: person.fullNameEn,
          fullNameAr: person.fullNameAr,
          jobTitleEn: person.jobTitleEn,
          jobTitleAr: person.jobTitleAr,
          status: person.status,
          counterLimit: person.counterLimit?.toString() ?? '',
          roleKeys: person.roles.map((entry) => entry.role.key),
          overrides: person.permissions.map((entry) => ({
            key: entry.permission.key,
            effect: entry.effect as 'ALLOW' | 'DENY',
          })),
        }))}
        rolePermissions={Object.fromEntries(
          roles.map((role) => [role.key, role.permissions.map((entry) => entry.permission.key)]),
        )}
        catalogue={PERMISSIONS.map((permission) => ({
          key: permission.key,
          module: permission.module,
          nameEn: permission.nameEn,
          nameAr: permission.nameAr,
          descriptionEn: permission.descriptionEn,
          descriptionAr: permission.descriptionAr,
          isSensitive: permission.isSensitive ?? false,
        }))}
        // The module names live in the catalogue beside the permissions they
        // group, so they are handed down rather than translated a second time
        // under keys that could drift from it.
        modules={MODULES.map((key) => ({
          key,
          nameEn: MODULE_LABELS[key].en,
          nameAr: MODULE_LABELS[key].ar,
        }))}
        currentUserId={session.user.id}
      />
    </div>
  );
}
