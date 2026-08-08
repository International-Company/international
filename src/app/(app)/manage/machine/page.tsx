import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { MACHINE_CURRENCIES, machineConfig } from '@/modules/exchange/machine.service';
import { rateBoard } from '@/modules/exchange/rates.service';
import { listDrawers } from '@/modules/drawers/drawer.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { MachineControlView } from './machine-control-view';

export const metadata: Metadata = { title: 'Exchange machine' };
export const dynamic = 'force-dynamic';

/**
 * The manager's side of the machine.
 *
 * Not a settings form: the same board the counter works off, with the switches
 * in it. The question a manager arrives with is "is my counter working, and
 * what is it doing" — and the board answers it in the shape the teller already
 * sees, so there is nothing to translate between the two screens.
 */
export default async function MachineControlPage() {
  const session = await requirePermission('exchange.rate.view');
  const { t } = await getTranslator();

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const [config, board, drawers, today, volume] = await Promise.all([
    machineConfig(),
    rateBoard(),
    listDrawers(),
    prisma.transaction.count({
      where: { type: 'EXCHANGE', status: 'POSTED', createdAt: { gte: start } },
    }),
    prisma.transaction.aggregate({
      where: { type: 'EXCHANGE', status: 'POSTED', createdAt: { gte: start } },
      _sum: { profitAmount: true },
    }),
  ]);

  const byCode = new Map(drawers.map((drawer) => [drawer.currencyCode, drawer]));

  return (
    <div className="space-y-4">
      <PageHeader title={t('machineControl.title')} description={t('machineControl.subtitle')} />

      <MachineControlView
        config={toJsonSafe(config)}
        board={toJsonSafe(board)}
        drawers={toJsonSafe(
          // Only the three the machine trades — the USDT drawer belongs to the
          // other tool and would only be noise here. JOD carries three decimals
          // where the other two carry two, so each is formatted from its own
          // currency rather than from a default.
          MACHINE_CURRENCIES.map((currency) => ({
            currency,
            balance: (byCode.get(currency)?.balance ?? 0n).toString(),
            decimals: byCode.get(currency)?.currency.decimals ?? 2,
          })),
        )}
        today={{ count: today, profit: (volume._sum.profitAmount ?? 0n).toString() }}
        canManage={session.user.permissions.includes('settings.manage')}
        canSeeMargin={session.user.permissions.includes('exchange.margin.view')}
      />
    </div>
  );
}
