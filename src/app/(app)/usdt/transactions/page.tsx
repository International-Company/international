import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { listChainTransactions } from '@/modules/usdt/sync.service';
import { listWallets } from '@/modules/usdt/wallet.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { ChainTransactionsView } from './chain-transactions-view';

export const metadata: Metadata = { title: 'Chain transactions' };
export const dynamic = 'force-dynamic';

export default async function ChainTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ walletId?: string }>;
}) {
  const { walletId } = await searchParams;
  const session = await requirePermission('usdt.transaction.view');
  const { t } = await getTranslator();

  const [result, wallets] = await Promise.all([
    listChainTransactions({ walletId, pageSize: 50 }),
    listWallets({ includeInactive: true }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('usdt.transactions')} description={t('usdt.subtitle')} />

      <ChainTransactionsView
        initial={toJsonSafe(result)}
        wallets={wallets.map((wallet) => ({
          id: wallet.id,
          label: wallet.label,
          labelAr: wallet.labelAr,
          network: wallet.network,
        }))}
        initialWalletId={walletId ?? ''}
        permissions={session.user.permissions}
      />
    </div>
  );
}
