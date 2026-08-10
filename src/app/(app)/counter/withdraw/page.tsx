import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { config } from '@/modules/usdt/withdrawal.service';
import { toJsonSafe } from '@/core/http/json';
import { Alert, PageHeader } from '@/ui/primitives';
import { WithdrawView } from './withdraw-view';

export const metadata: Metadata = { title: 'Sell USDT' };
export const dynamic = 'force-dynamic';

export default async function WithdrawPage() {
  const session = await requirePermission('usdt.withdrawal.use');
  const { t } = await getTranslator();

  const settings = await config();

  if (!settings.enabled) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('withdraw.title')} description={t('withdraw.subtitle')} />
        <Alert tone="neutral" title={t('withdraw.disabledTitle')}>
          {t('withdraw.disabledBody')}
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t('withdraw.title')} description={t('withdraw.subtitle')} />

      {/*
        Nothing can be sent from a branch that monitors no wallet. Said here
        rather than left as a failure at the moment of recording, when the
        customer's money is already on the counter.
      */}
      {settings.wallets.length === 0 ? (
        <Alert tone="warning" title={t('withdraw.noWalletsTitle')}>
          {t('withdraw.noWalletsBody')}
        </Alert>
      ) : (
        <WithdrawView config={toJsonSafe(settings)} permissions={session.user.permissions} />
      )}
    </div>
  );
}
