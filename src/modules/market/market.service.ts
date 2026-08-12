import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';

/**
 * The market ticker — the pairs an exchange office watches all day.
 *
 * ## One table, one formula
 *
 * Every source is reduced to the same thing: **how many units of a symbol one
 * dollar buys**. Gold arrives priced the other way round and is inverted on the
 * way in; USDT arrives against the dollar directly. Once everything is in those
 * terms, any pair at all is one division —
 *
 *     A/B  =  perDollar[B] / perDollar[A]
 *
 * — which is why adding a pair here is a line of configuration rather than a
 * line of code, and why `XAU/USD`, `EUR/USD` and `USD/ILS` need no special
 * cases between them.
 *
 * ## What this is not
 *
 * It is not a price. Nothing in the trading path reads this module and none
 * does: the office quotes the board its manager publishes, and a market figure
 * that could reach a receipt would be the most expensive decoration in the
 * system. The strip carries the word "market" at its head for the same reason.
 *
 * ## Failure is silence
 *
 * A provider having a bad afternoon must never be an error in a counter
 * application and must never delay a page. Every failure keeps the last good
 * answer, and the office carries on pricing from its own board — which is the
 * only thing it was ever pricing from.
 */

const log = createLogger('market');

const SCALE = 100_000_000n;

/** Pairs shown when the manager has not said otherwise. */
export const DEFAULT_PAIRS = 'USD/ILS,EUR/USD,GBP/USD,USD/JOD,USD/TRY,USD/EGP,XAU/USD';

export interface TickerPair {
  /** As written: `USD/ILS`. */
  pair: string;
  base: string;
  quote: string;
  /** How many quote units one base unit costs, scaled 1e8. */
  rate: bigint;
  /** DAILY | LIVE — so a strip never implies a freshness it does not have. */
  cadence: 'DAILY' | 'LIVE';
}

export interface Ticker {
  pairs: TickerPair[];
  fetchedAt: Date;
  /** True when the sources failed and this is the last good answer. */
  stale: boolean;
}

/*
 * One upstream call serves every screen in the office. Twenty phones asking a
 * free provider directly is twenty times the traffic for one answer, and the
 * kind of thing that gets an address blocked.
 */
let cache: { ticker: Ticker; until: number } | null = null;

const scaled = (value: number): bigint => BigInt(Math.round(value * Number(SCALE)));

/** Fetches with a deadline; a slow provider must not become a slow page. */
async function get(url: string, seconds = 6): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(seconds * 1000),
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/**
 * Everything reduced to units per one dollar.
 *
 * Paper money comes from a free reference that moves once a day. Gold and USDT
 * move during it, and come from sources that do too — so each symbol carries
 * the cadence it actually has rather than the best one in the set.
 */
async function perDollar(): Promise<{
  rates: Map<string, number>;
  cadence: Map<string, 'DAILY' | 'LIVE'>;
}> {
  const rates = new Map<string, number>([['USD', 1]]);
  const cadence = new Map<string, 'DAILY' | 'LIVE'>([['USD', 'DAILY']]);

  const [fx, gold, tether] = await Promise.all([
    get('https://open.er-api.com/v6/latest/USD') as Promise<{
      result?: string;
      rates?: Record<string, number>;
    } | null>,
    get('https://api.gold-api.com/price/XAU') as Promise<{ price?: number } | null>,
    get('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd') as Promise<{
      tether?: { usd?: number };
    } | null>,
  ]);

  if (fx?.result === 'success' && fx.rates) {
    for (const [code, value] of Object.entries(fx.rates)) {
      if (typeof value === 'number' && value > 0) {
        rates.set(code, value);
        cadence.set(code, 'DAILY');
      }
    }
  }

  // Gold is quoted as dollars per ounce, which is the inverse of everything
  // else in this table.
  if (gold?.price && gold.price > 0) {
    rates.set('XAU', 1 / gold.price);
    cadence.set('XAU', 'LIVE');
  }

  if (tether?.tether?.usd && tether.tether.usd > 0) {
    rates.set('USDT', 1 / tether.tether.usd);
    cadence.set('USDT', 'LIVE');
  }

  return { rates, cadence };
}

/** Splits `USD/ILS` into its two halves, ignoring anything malformed. */
function parsePairs(raw: string): { base: string; quote: string }[] {
  return raw
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean)
    .flatMap((entry) => {
      const [base, quote] = entry.split('/');
      return base && quote ? [{ base, quote }] : [];
    });
}

/**
 * The ticker as it stands.
 *
 * Cached for as long as the manager says, and a failed round is retried sooner
 * than a good one is refreshed.
 */
export async function ticker(db: DbClient = prisma): Promise<Ticker> {
  if (cache && cache.until > Date.now()) return cache.ticker;

  const [configured, minutes] = await Promise.all([
    settings.getString('market.pairs').catch(() => DEFAULT_PAIRS),
    settings.getNumber('market.refreshMinutes').catch(() => 10),
  ]);

  const wanted = parsePairs(configured || DEFAULT_PAIRS);
  const { rates, cadence } = await perDollar();

  const pairs = wanted.flatMap(({ base, quote }) => {
    const from = rates.get(base);
    const to = rates.get(quote);
    // A pair the sources cannot price is left out. There is no sensible
    // invented value for it, and a blank on a ticker is worse than an absence.
    if (!from || !to) return [];

    return [
      {
        pair: `${base}/${quote}`,
        base,
        quote,
        rate: scaled(to / from),
        // A pair is only as live as its slower half.
        cadence:
          cadence.get(base) === 'LIVE' && cadence.get(quote) === 'LIVE'
            ? ('LIVE' as const)
            : ('DAILY' as const),
      },
    ];
  });

  if (pairs.length === 0 && cache) {
    log.debug('Market unreachable; serving the last good answer');
    const stale = { ...cache.ticker, stale: true };
    cache = { ticker: stale, until: Date.now() + 60_000 };
    return stale;
  }

  const fresh: Ticker = { pairs, fetchedAt: new Date(), stale: pairs.length === 0 };
  cache = {
    ticker: fresh,
    until: Date.now() + (pairs.length === 0 ? 60_000 : Math.max(1, minutes) * 60_000),
  };

  log.debug('Market refreshed', { pairs: pairs.length });
  return fresh;
}

/** Forgets the cached answer, for when the settings behind it change. */
export function forget(): void {
  cache = null;
}
