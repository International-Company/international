import type { Metadata } from 'next';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { PageHeader } from '@/ui/primitives';
import { MyWalletView } from './my-wallet-view';

export const metadata: Metadata = { title: 'My wallet' };
export const dynamic = 'force-dynamic';

/** محفظتي — the transfers handed to the teller's Jawwal Pay wallet, and its count. */
export default async function MyWalletPage() {
  await requirePagePermission('ewallet.use');
  const { t } = await getTranslator();
  return (
    <div className="space-y-4">
      <PageHeader title={t('ewallet.mineTitle')} description={t('ewallet.mineSubtitle')} />
      <MyWalletView />
    </div>
  );
}
