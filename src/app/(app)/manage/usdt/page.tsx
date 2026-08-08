import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { listWallets, portfolio } from '@/modules/usdt/wallet.service';
import { availableNetworks } from '@/modules/usdt/providers';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { WalletsView } from './wallets-view';

export const metadata: Metadata = { title: 'USDT wallets' };
export const dynamic = 'force-dynamic';

export default async function WalletsPage() {
  const session = await requirePermission('usdt.wallet.view');
  const { t } = await getTranslator();

  const [wallets, position] = await Promise.all([
    listWallets({ includeInactive: true }),
    portfolio(),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('usdt.title')} description={t('usdt.subtitle')} />

      <WalletsView
        wallets={toJsonSafe(wallets)}
        portfolio={toJsonSafe(position)}
        networks={availableNetworks()}
        permissions={session.user.permissions}
      />
    </div>
  );
}
