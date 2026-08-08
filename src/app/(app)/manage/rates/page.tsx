import type { Metadata } from 'next';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { rateBoard, rateHistory, getActiveRate } from '@/modules/exchange/rates.service';
import { enabledPairs, MACHINE_CURRENCIES } from '@/modules/exchange/machine.service';
import { counterAddresses } from '@/modules/usdt/counter.service';
import { toJsonSafe } from '@/core/http/json';
import { PageHeader } from '@/ui/primitives';
import { RatesView } from './rates-view';

export const metadata: Metadata = { title: 'Exchange rates' };
export const dynamic = 'force-dynamic';

/**
 * The rates the two tools price from.
 *
 * Assembled around what the tools actually need rather than around what has
 * been published: every pair the machine offers appears here whether it has a
 * rate or not, because a pair with no rate is the reason the machine refuses to
 * quote, and an empty row is the only thing that says so.
 */
export default async function RatesPage() {
  const session = await requirePermission('exchange.rate.view');
  const { t } = await getTranslator();

  const [board, history, currencies, pairs, addresses] = await Promise.all([
    rateBoard(),
    rateHistory({ limit: 80 }),
    prisma.currency.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, nameEn: true, nameAr: true, decimals: true },
    }),
    enabledPairs(),
    counterAddresses(),
  ]);

  // The USDT window prices in whatever currency the teller chooses to pay out,
  // so every cash currency it can settle into needs a rate against USDT too.
  const usdtPairs = addresses.length > 0
    ? MACHINE_CURRENCIES.map((code) => `USDT/${code}`)
    : [];

  const required = [...pairs, ...usdtPairs];

  // Which of those the board can actually serve — in either direction, since
  // pricing inverts a stored pair when it has to.
  const served = await Promise.all(
    required.map(async (pair) => {
      const [from, to] = pair.split('/') as [string, string];
      const direct = await getActiveRate(from, to);
      const reverse = direct ? null : await getActiveRate(to, from);

      return {
        pair,
        from,
        to,
        rateId: direct?.id ?? reverse?.id ?? null,
        // A pair with no stored rate of its own is still priceable when the
        // opposite direction exists — the quote inverts it. Naming the pair
        // that actually serves it is what stops the row reading "no rate" for
        // something the machine trades happily.
        servedBy: direct ? pair : reverse ? `${to}/${from}` : null,
      };
    }),
  );

  return (
    <div className="space-y-4">
      <PageHeader title={t('rates.title')} description={t('rates.subtitle')} />

      <RatesView
        board={toJsonSafe(board)}
        history={toJsonSafe(history)}
        currencies={currencies}
        coverage={toJsonSafe(served)}
        canManage={session.user.permissions.includes('exchange.rate.manage')}
      />
    </div>
  );
}
