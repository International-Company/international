import { route } from '@/core/http/route';
import * as settings from '@/modules/settings/settings.service';
import * as market from '@/modules/market/market.service';

/**
 * The market ticker.
 *
 * Signed in is enough. These are the world's pairs — gold, the euro, the lira —
 * not the office's price list, and every screen in the building shows the same
 * strip. What keeps it from being mistaken for a quote is that it says "market"
 * at its head and that nothing in the trading path can read it.
 */
export const GET = route({
  handler: async () => {
    if (!(await settings.getBoolean('market.enabled').catch(() => false))) {
      return { enabled: false, pairs: [] };
    }

    const data = await market.ticker();

    return {
      enabled: true,
      stale: data.stale,
      fetchedAt: data.fetchedAt.toISOString(),
      pairs: data.pairs.map((pair) => ({
        pair: pair.pair,
        quote: pair.quote,
        rate: pair.rate.toString(),
        cadence: pair.cadence,
      })),
    };
  },
});
