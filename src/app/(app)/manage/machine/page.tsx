import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import {
  MACHINE_CURRENCIES,
  MACHINE_PAIRS,
  enabledPairs,
  machineConfig,
  pairKey,
} from '@/modules/exchange/machine.service';
import { getActiveRate } from '@/modules/exchange/rates.service';
import { listDrawers } from '@/modules/drawers/drawer.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { MachineControlView } from './machine-control-view';

export const metadata: Metadata = { title: 'Exchange machine' };
export const dynamic = 'force-dynamic';

/**
 * The manager's side of the machine.
 *
 * Not a settings form. The question a manager arrives with is "is my counter
 * working, and what is it doing" — so each pair is shown with everything that
 * decides whether the teller can actually trade it: whether it is switched on,
 * whether a rate exists, and whether the drawer can pay it out. A toggle that
 * turns a pair on while its rate is missing has told the manager nothing.
 */
export default async function MachineControlPage() {
  const session = await requirePermission('exchange.rate.view');
  const { t } = await getTranslator();

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const [config, offered, drawers, today, volume] = await Promise.all([
    machineConfig(),
    enabledPairs(),
    listDrawers(),
    prisma.transaction.count({
      where: { type: 'EXCHANGE', status: 'POSTED', createdAt: { gte: start } },
    }),
    prisma.transaction.aggregate({
      where: { type: 'EXCHANGE', status: 'POSTED', createdAt: { gte: start } },
      _sum: { profitAmount: true },
    }),
  ]);

  const balances = new Map(drawers.map((drawer) => [drawer.currencyCode, drawer.balance]));
  // JOD carries three decimals where the other two carry two, so every amount
  // on this page is formatted from the currency rather than from a default.
  const decimals = new Map(
    drawers.map((drawer) => [drawer.currencyCode, drawer.currency.decimals]),
  );

  // Everything that decides whether a pair can be traded, resolved per pair
  // rather than left for the manager to assemble from three screens.
  const pairs = await Promise.all(
    MACHINE_PAIRS.map(async ([from, to]) => {
      const key = pairKey(from, to);
      const direct = await getActiveRate(from, to);
      const reverse = direct ? null : await getActiveRate(to, from);

      return {
        key,
        from,
        to,
        enabled: offered.includes(key),
        hasRate: Boolean(direct ?? reverse),
        servedBy: direct ? key : reverse ? pairKey(to, from) : null,
        payoutBalance: (balances.get(to) ?? 0n).toString(),
        payoutDecimals: decimals.get(to) ?? 2,
      };
    }),
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t('machineControl.title')} description={t('machineControl.subtitle')} />

      <MachineControlView
        config={toJsonSafe(config)}
        pairs={toJsonSafe(pairs)}
        drawers={toJsonSafe(
          // Only the three the machine trades — the USDT drawer belongs to the
          // other tool and would only be noise here.
          MACHINE_CURRENCIES.map((currency) => ({
            currency,
            balance: (balances.get(currency) ?? 0n).toString(),
            decimals: decimals.get(currency) ?? 2,
          })),
        )}
        today={{
          count: today,
          profit: (volume._sum.profitAmount ?? 0n).toString(),
        }}
        canManage={session.user.permissions.includes('settings.manage')}
        canSeeMargin={session.user.permissions.includes('exchange.margin.view')}
      />
    </div>
  );
}
