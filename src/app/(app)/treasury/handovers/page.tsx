import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requireAnyPermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { HandoversView } from './handovers-view';

export const metadata: Metadata = { title: 'Handovers' };
export const dynamic = 'force-dynamic';

/**
 * The handover screen, for whichever side of it the person is on.
 *
 * Reachable by either permission, because both parties work here — the manager
 * declaring a float and counting what comes back, the teller counting what he
 * is given and declaring what he returns. The view shows each of them their own
 * half; the server decides which half that is.
 */
export default async function HandoversPage() {
  const session = await requireAnyPermission(
    'treasury.handover.manage',
    'treasury.handover.receive',
  );
  const { t } = await getTranslator();

  const isTreasury = session.user.permissions.includes('treasury.handover.manage');

  const [tellers, currencies] = await Promise.all([
    // Only people who can actually take a handover; offering the rest would
    // create a document nobody is able to count.
    isTreasury
      ? prisma.user.findMany({
          where: {
            status: 'ACTIVE',
            id: { not: session.user.id },
            OR: [
              { roles: { some: { role: { permissions: { some: { permission: { key: 'treasury.handover.receive' } } } } } } },
              { permissions: { some: { permission: { key: 'treasury.handover.receive' }, effect: 'ALLOW' } } },
            ],
          },
          select: { id: true, fullNameEn: true, fullNameAr: true },
          orderBy: { fullNameAr: 'asc' },
        })
      : Promise.resolve([]),
    prisma.currency.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true, decimals: true, kind: true },
    }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('handover.title')} description={t('handover.subtitle')} />

      <HandoversView
        tellers={tellers}
        currencies={currencies}
        permissions={session.user.permissions}
        userId={session.user.id}
      />
    </div>
  );
}
