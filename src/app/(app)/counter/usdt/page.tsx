import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requirePagePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { counterAddresses, listRequests } from '@/modules/usdt/counter.service';
import { getBoolean, getNumber } from '@/modules/settings/settings.service';
import { toJsonSafe } from '@/core/http/json';
import { Alert, PageHeader } from '@/ui/primitives';
import { CounterView } from './counter-view';

export const metadata: Metadata = { title: 'Receive USDT' };
export const dynamic = 'force-dynamic';

export default async function UsdtCounterPage() {
  const session = await requirePagePermission('usdt.counter.use');
  const { t } = await getTranslator();

  const enabled = await getBoolean('usdt.counterEnabled');

  if (!enabled) {
    return (
      <div className="space-y-4">
        <PageHeader title={t('counter.title')} description={t('counter.subtitle')} />
        <Alert tone="neutral" title={t('counter.disabledTitle')}>
          {t('counter.disabledBody')}
        </Alert>
      </div>
    );
  }

  const actor = {
    id: session.user.id,
    name: session.user.fullNameEn,
    permissions: session.user.permissions,
    branchId: session.user.branchId,
  };

  const [addresses, open, windowMinutes, currencies] = await Promise.all([
    counterAddresses(),
    listRequests({ status: ['OPEN', 'MATCHED'], pageSize: 20 }, actor),
    getNumber('usdt.counterRequestMinutes'),
    prisma.currency.findMany({
      where: { isActive: true, kind: 'FIAT' },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true, decimals: true },
    }),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title={t('counter.title')} description={t('counter.subtitle')} />

      {addresses.length === 0 ? (
        <Alert tone="warning" title={t('counter.noAddressesTitle')}>
          {t('counter.noAddressesBody')}
        </Alert>
      ) : (
        <CounterView
          addresses={toJsonSafe(addresses)}
          openRequests={toJsonSafe(open.rows)}
          currencies={currencies}
          windowMinutes={windowMinutes}
          permissions={session.user.permissions}
        />
      )}
    </div>
  );
}
