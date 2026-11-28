import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { PageHeader } from '@/ui/primitives';
import { BinanceDepositsView } from './deposits-view';

export const metadata: Metadata = { title: 'Binance deposits' };
export const dynamic = 'force-dynamic';

/**
 * Everything the office's Binance account took in — any coin, any network,
 * from another Binance user or over a chain, and Binance Pay — in one list, so
 * the office sees whatever a customer sent there, whatever they sent it in.
 */
export default async function BinanceDepositsPage() {
  const session = await requirePagePermission('usdt.transaction.view');
  const { t } = await getTranslator();
  const wallets = await prisma.wallet.findMany({
    where: { network: 'BINANCE', isActive: true },
    select: { id: true, label: true, labelAr: true },
    orderBy: { counterSortOrder: 'asc' },
  });

  return (
    <div className="space-y-4">
      <PageHeader title={t('binanceDeposits.title')} description={t('binanceDeposits.subtitle')} />
      <BinanceDepositsView
        wallets={wallets}
        canSync={session.user.permissions.includes('usdt.wallet.sync')}
      />
    </div>
  );
}
