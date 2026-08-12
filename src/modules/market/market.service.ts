import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';

/**
 * The market ticker — the pairs an exchange office watches all day.
 *
 * ## Two grades of source, and the better one wins per pair
 *
 * The live source quotes pairs directly and moves through the day; the free
 * reference quotes everything against the dollar and moves once. So each pair
 * is asked of the live source first and falls back to the reference when it has
 * nothing — a lira that is trading answers in seconds, and a dinar the live
 * source has not moved since morning still appears rather than vanishing.
 *
 * Every pair therefore carries **which source answered and when**, because a
 * strip that showed both at the same freshness would be lying about half of it.
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
  /** Which source answered, so a manager can see it rather than assume it. */
  source: string;
  /** When that source last moved this figure. */
  asOf: Date;
}

export interface Ticker {
  pairs: TickerPair[];
  fetchedAt: Date;
  /** True when the sources failed and this is the last good answer. */
  stale: boolean;
  /** Pairs asked for that no source could price, so the gap is visible. */
  missing: string[];
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
  /*
   * The dollar is the unit this table is written in, so it is exactly one and
   * cannot be stale. Marking it daily would drag every pair it appears in down
   * to daily — including gold, which is quoted live against it.
   */
  const cadence = new Map<string, 'DAILY' | 'LIVE'>([['USD', 'LIVE']]);

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
      // The reference lists the dollar against itself at exactly one. Taking it
      // would overwrite the unit's own entry above and mark it daily, which
      // then drags every pair containing it — gold included — down with it.
      if (code === 'USD') continue;
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

/**
 * A pair straight from the market, when the market is open to being asked.
 *
 * Quoted directly rather than derived, so it carries the spread the world is
 * actually trading on rather than a figure assembled from two dollar rates.
 * Anything unreachable simply returns nothing and the reference takes over.
 */
async function live(base: string, quote: string): Promise<{ rate: number; asOf: Date } | null> {
  const symbol = `${base}${quote}=X`;
  const data = (await get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`,
    5,
  )) as { chart?: { result?: { meta?: { regularMarketPrice?: number; regularMarketTime?: number } }[] } } | null;

  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice || meta.regularMarketPrice <= 0) return null;

  return {
    rate: meta.regularMarketPrice,
    asOf: new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000),
  };
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
  return refresh(db);
}

/**
 * Asks every source again, ignoring whatever is cached.
 *
 * Separate from `ticker` because a manager who presses "refresh" means it — a
 * button that returned the same cached answer it was pressed to escape would
 * teach him not to trust the button.
 */
export async function refresh(db: DbClient = prisma): Promise<Ticker> {
  const [configured, minutes, useLive] = await Promise.all([
    settings.getString('market.pairs').catch(() => DEFAULT_PAIRS),
    settings.getNumber('market.refreshMinutes').catch(() => 10),
    settings.getBoolean('market.liveSource').catch(() => true),
  ]);

  const wanted = parsePairs(configured || DEFAULT_PAIRS);

  /*
   * The live source is asked pair by pair and the reference once for all of
   * them, both at the same time — so the slower of the two sets the wait rather
   * than the two of them in sequence.
   */
  const [quoted, { rates, cadence }] = await Promise.all([
    useLive
      ? Promise.all(wanted.map((pair) => live(pair.base, pair.quote)))
      : Promise.resolve(wanted.map(() => null)),
    perDollar(),
  ]);

  const missing: string[] = [];

  const pairs = wanted.flatMap(({ base, quote }, index) => {
    const name = `${base}/${quote}`;

    // Straight from the market, when the market answered.
    const direct = quoted[index];
    if (direct) {
      return [
        {
          pair: name,
          base,
          quote,
          rate: scaled(direct.rate),
          cadence: 'LIVE' as const,
          source: 'market',
          asOf: direct.asOf,
        },
      ];
    }

    // Otherwise assembled from the two dollar rates.
    const from = rates.get(base);
    const to = rates.get(quote);
    const pace =
      cadence.get(base) === 'LIVE' && cadence.get(quote) === 'LIVE'
        ? ('LIVE' as const)
        : ('DAILY' as const);
    if (!from || !to) {
      // A pair nothing can price is named rather than silently dropped: a gap
      // on the strip should be explainable from the settings screen.
      missing.push(name);
      return [];
    }

    return [
      {
        pair: name,
        base,
        quote,
        rate: scaled(to / from),
        // A pair is only as live as its slower half.
        cadence: pace,
        /*
         * Named for what actually answered rather than for which branch of this
         * function assembled it: gold and the coin come from live sources even
         * when the pair had to be derived, and calling that a daily reference
         * would be the screen telling a small lie about its own freshness.
         */
        source: pace === 'LIVE' ? 'market' : 'reference',
        asOf: new Date(),
      },
    ];
  });

  if (pairs.length === 0 && cache) {
    log.debug('Market unreachable; serving the last good answer');
    const stale = { ...cache.ticker, stale: true };
    cache = { ticker: stale, until: Date.now() + 60_000 };
    return stale;
  }

  const fresh: Ticker = {
    pairs,
    fetchedAt: new Date(),
    stale: pairs.length === 0,
    missing,
  };

  cache = {
    ticker: fresh,
    until: Date.now() + (pairs.length === 0 ? 60_000 : Math.max(1, minutes) * 60_000),
  };

  log.debug('Market refreshed', {
    pairs: pairs.length,
    live: pairs.filter((pair) => pair.source === 'market').length,
    missing: missing.length,
  });
  return fresh;
}

/** Forgets the cached answer, for when the settings behind it change. */
export function forget(): void {
  cache = null;
}
