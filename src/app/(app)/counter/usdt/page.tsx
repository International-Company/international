import type { Metadata } from 'next';
import { prisma } from '@/core/db/prisma';
import { requirePageAnyPermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { counterAddresses, listRequests } from '@/modules/usdt/counter.service';
import { config as withdrawalConfig } from '@/modules/usdt/withdrawal.service';
import { getBoolean, getString } from '@/modules/settings/settings.service';
import { transferChannels as machineTransferChannels } from '@/modules/exchange/machine.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { UsdtView, type Direction } from './usdt-view';

export const metadata: Metadata = { title: 'USDT' };
export const dynamic = 'force-dynamic';

/**
 * The USDT counter, both directions.
 *
 * Reachable by either permission: a teller who may only receive, one who may
 * only send, and one who does both all arrive here, and the screen offers each
 * of them exactly what they hold.
 *
 * Both sides are loaded on the server in one pass, but only the sides the
 * person can actually work — there is no sense reading the chain addresses for
 * somebody who may only sell, and a request for money should not do work it
 * cannot use.
 */
export default async function UsdtPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string }>;
}) {
  const session = await requirePageAnyPermission('usdt.counter.use', 'usdt.withdrawal.use');
  const { t } = await getTranslator();
  const { d } = await searchParams;

  const canReceive = session.user.permissions.includes('usdt.counter.use');
  const canSend = session.user.permissions.includes('usdt.withdrawal.use');

  const actor = {
    id: session.user.id,
    name: session.user.fullNameEn,
    permissions: session.user.permissions,
    branchId: session.user.branchId,
  };

  const [receiveOn, sendConfig] = await Promise.all([
    canReceive ? getBoolean('usdt.counterEnabled') : Promise.resolve(false),
    canSend ? withdrawalConfig() : Promise.resolve(null),
  ]);

  const [addresses, open, currencies, companyName, transferChannels] = await Promise.all([
    canReceive && receiveOn ? counterAddresses() : Promise.resolve([]),
    canReceive && receiveOn
      ? listRequests({ status: ['OPEN', 'MATCHED'], pageSize: 20 }, actor)
      : Promise.resolve({ rows: [] }),
    canReceive && receiveOn
      ? prisma.currency.findMany({
          where: { isActive: true, kind: 'FIAT' },
          orderBy: { sortOrder: 'asc' },
          select: { code: true, nameEn: true, nameAr: true, decimals: true },
        })
      : Promise.resolve([]),
    canReceive && receiveOn ? getString('company.name.ar') : Promise.resolve(''),
    canReceive && receiveOn ? machineTransferChannels() : Promise.resolve([]),
  ]);

  /*
   * Which side opens. The address wins when it names one the person may work;
   * otherwise whichever they hold — and receiving first when they hold both,
   * because a customer arriving with coins is the commoner errand.
   */
  const asked: Direction | null =
    d === 'out' ? 'out' : d === 'in' ? 'in' : d === 'sale' ? 'sale' : null;
  const initial: Direction =
    (asked === 'out' || asked === 'sale') && canSend
      ? asked
      : asked === 'in' && canReceive
        ? 'in'
        : canReceive
          ? 'in'
          : 'out';

  return (
    <div className="space-y-4">
      <PageHeader title={t('usdtWindow.title')} description={t('usdtWindow.subtitle')} />

      <UsdtView
        initial={initial}
        permissions={session.user.permissions}
        receive={{ enabled: receiveOn, allowed: canReceive }}
        send={{ enabled: sendConfig?.enabled ?? false, allowed: canSend }}
        counter={
          canReceive && receiveOn && addresses.length > 0
            ? {
                addresses: toJsonSafe(addresses),
                openRequests: toJsonSafe(open.rows),
                currencies,
                companyName,
                transferChannels,
                permissions: session.user.permissions,
              }
            : null
        }
        withdraw={
          canSend && sendConfig?.enabled && sendConfig.wallets.length > 0
            ? { config: toJsonSafe(sendConfig), permissions: session.user.permissions }
            : null
        }
        sale={
          canSend && sendConfig
            ? {
                currencies: sendConfig.currencies.map(({ code, decimals }) => ({ code, decimals })),
                transferChannels: sendConfig.transferChannels,
              }
            : null
        }
      />
    </div>
  );
}
