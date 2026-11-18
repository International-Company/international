import type { Metadata } from 'next';
import { requirePageAnyPermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { hiddenMenus } from '@/modules/bank/bank-desk';
import { resolveRolePermissions, SYSTEM_ROLES } from '@/core/security/permissions';
import { visibleNavigation } from '@/app/_shell/navigation';
import { PageHeader } from '@/ui/primitives';
import { TellerMenus } from './teller-menus';

export const metadata: Metadata = { title: 'Tellers’ menus' };
export const dynamic = 'force-dynamic';

/**
 * The menus the tellers see, each one the supervisor can hide.
 *
 * Read from the teller's own role, so the list is exactly what a teller would
 * otherwise have in their sidebar — this page itself left out, since hiding it
 * from tellers who never see it means nothing.
 */
export default async function TellerMenusPage() {
  await requirePageAnyPermission('treasury.supervise', 'settings.manage');
  const { t } = await getTranslator();

  const teller = SYSTEM_ROLES.find((role) => role.key === 'TELLER');
  const permissions = teller ? resolveRolePermissions(teller) : [];
  const sections = visibleNavigation(permissions)
    .map((section) => ({
      labelKey: section.labelKey,
      items: section.items
        .filter((item) => item.href !== '/counter/menus')
        .map((item) => ({ href: item.href, labelKey: item.labelKey })),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <div className="space-y-4">
      <PageHeader title={t('tellerMenus.title')} description={t('tellerMenus.subtitle')} />
      <TellerMenus sections={sections} hidden={await hiddenMenus()} />
    </div>
  );
}
