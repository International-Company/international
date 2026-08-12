import { route } from '@/core/http/route';
import * as settings from '@/modules/settings/settings.service';
import * as market from '@/modules/market/market.service';
import { listActiveRates } from '@/modules/exchange/rates.service';

/**
 * The market, and the office's own board beside it.
 *
 * The two travel together on purpose. A market figure delivered on its own is a
 * second price with no context, and somebody will eventually quote it; delivered
 * next to what the office actually charges, it reads as what it is — a
 * comparison, and the only interesting thing about it is the gap.
 *
 * Behind `exchange.rate.view`: the people who set prices see this, the people
 * who quote them do not. That removes the misquoting risk rather than warning
 * about it.
 */
export const GET = route({
  permissions: ['exchange.rate.view'],
  handler: async () => {
    if (!(await settings.getBoolean('market.enabled').catch(() => false))) {
      return { enabled: false, rows: [] };
    }

    const [snapshot, board] = await Promise.all([market.snapshot(), listActiveRates()]);

    /*
     * The board is published per pair and per channel. What belongs beside a
     * market figure is the cash price — the one a customer at the window is
     * actually offered — so a broker-only pair contributes nothing here rather
     * than being shown as if it were the counter's price.
     */
    const cash = board.filter((rate) => rate.channel === 'CASH');

    return {
      enabled: true,
      base: snapshot.base,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      stale: snapshot.stale,
      rows: snapshot.quotes.map((quote) => {
        const direct = cash.find(
          (rate) => rate.baseCode === quote.code && rate.quoteCode === snapshot.base,
        );

        return {
          code: quote.code,
          market: quote.rate.toString(),
          asOf: quote.asOf.toISOString(),
          cadence: quote.cadence,
          // Absent when the manager has published nothing for this pair, which
          // is itself worth seeing on the bar.
          buy: direct?.buyRate.toString() ?? null,
          sell: direct?.sellRate.toString() ?? null,
        };
      }),
    };
  },
});
