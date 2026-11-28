import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { EwalletsView } from './ewallets-view';

export const metadata: Metadata = { title: 'E-wallets' };
export const dynamic = 'force-dynamic';

/** محافظ جوال باي — each teller's wallet: topped up, handed transfers, counted. */
export default async function EwalletsPage() {
  await requirePagePermission('treasury.handover.manage');
  const { t } = await getTranslator();
  const tellers = await prisma.user.findMany({
    where: { status: 'ACTIVE', isSystem: false },
    select: { id: true, fullNameAr: true },
    orderBy: { fullNameAr: 'asc' },
  });
  return (
    <div className="space-y-4">
      <PageHeader title={t('ewallet.title')} description={t('ewallet.subtitle')} />
      <EwalletsView tellers={tellers} />
    </div>
  );
}
