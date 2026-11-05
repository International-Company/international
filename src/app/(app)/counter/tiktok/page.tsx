import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requirePagePermission } from '@/modules/auth/context';
import { transferChannels } from '@/modules/exchange/machine.service';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { TiktokView } from './tiktok-view';

export const metadata: Metadata = { title: 'TikTok' };
export const dynamic = 'force-dynamic';

export default async function TiktokPage() {
  const session = await requirePagePermission('exchange.remittance.use');
  const { t } = await getTranslator();

  const [currencies, channels] = await Promise.all([
    prisma.currency.findMany({
      where: { isActive: true, kind: 'FIAT' },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true },
    }),
    transferChannels(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('tiktok.title')} description={t('tiktok.subtitle')} />
      <TiktokView
        currencies={currencies}
        channels={channels}
        permissions={session.user.permissions}
      />
    </div>
  );
}
