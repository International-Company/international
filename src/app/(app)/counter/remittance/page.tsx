import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { config } from '@/modules/exchange/remittance.service';
import { toJsonSafe } from '@/core/http/json';
import { Alert, PageHeader } from '@/ui/primitives';
import { RemittanceView } from './remittance-view';

export const metadata: Metadata = { title: 'Remittances' };
export const dynamic = 'force-dynamic';

export default async function RemittancePage() {
  const session = await requirePermission('exchange.remittance.use');
  const { t } = await getTranslator();

  const settings = await config();

  return (
    <div className="space-y-4">
      <PageHeader title={t('remittance.title')} description={t('remittance.subtitle')} />

      {/*
        Nothing can be sent until the manager has written down where it may go.
        Said here rather than left as a failure at the moment of posting, when
        the money is already on the counter.
      */}
      {settings.destinations.length === 0 && (
        <Alert tone="warning" title={t('remittance.noDestinations')}>
          {t('remittance.noDestinationsHint')}
        </Alert>
      )}

      <RemittanceView config={toJsonSafe(settings)} permissions={session.user.permissions} />
    </div>
  );
}
