import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { createLogger } from '@/core/logger/logger';
import * as settings from '@/modules/settings/settings.service';
import { baseCurrency } from '@/modules/ledger/cutoff.service';

/**
 * Where the market is — beside where the office's board is.
 *
 * ## The danger this is built around
 *
 * Everything in this system prices from one place: the board the manager
 * publishes. A second number on screen that looks like a rate is the most
 * expensive kind of decoration — a teller reads it aloud to a customer, and the
 * office has quoted a price nobody set.
 *
 * So three rules hold, and the code is arranged to keep them:
 *
 * 1. **Nothing here prices anything.** No caller in the trading path may read
 *    this module, and none does. It is shown and never used.
 * 2. **It is never shown alone.** Every market figure appears beside the
 *    office's own published rate, so the screen reads as a comparison rather
 *    than as an alternative source.
 * 3. **It is behind `exchange.rate.view`.** The people who set prices see it;
 *    the people who quote them do not, which removes the misquoting risk at its
 *    root rather than warning about it.
 *
 * ## Two sources, two cadences, said out loud
 *
 * Free reference data for shekels and dinars refreshes **once a day** — calling
 * that "live" would be the first lie the screen tells. USDT genuinely moves by
 * the minute and has a live free source. Each quote therefore carries its own
 * `asOf`, and the bar shows how old each one is rather than implying they share
 * a freshness they do not.
 *
 * ## Failure is silence
 *
 * A rate provider having a bad afternoon must never be visible as an error in a
 * counter application, and must never delay a page. Every failure returns the
 * last good answer, or nothing — and the office carries on pricing from its own
 * board, which is the only thing it was ever pricing from.
 */

const log = createLogger('market');

/** Money and rates in this system are scaled by this much. */
const SCALE = 100_000_000n;

export interface MarketQuote {
  /** The currency being priced, against the office's base. */
  code: string;
  /** How many base units one unit costs, scaled 1e8. */
  rate: bigint;
  /** When the source last moved this figure. */
  asOf: Date;
  /** DAILY | LIVE — the cadence, so a screen never implies more than it has. */
  cadence: 'DAILY' | 'LIVE';
}

export interface MarketSnapshot {
  base: string;
  quotes: MarketQuote[];
  fetchedAt: Date;
  /** True when every source failed and this is the last good answer. */
  stale: boolean;
}

/*
 * One upstream call serves every screen in the office.
 *
 * Twenty phones polling a free provider directly would be twenty times the
 * traffic for one answer, and the kind of thing that gets an address blocked.
 */
let cache: { snapshot: MarketSnapshot; until: number } | null = null;

const scaled = (value: number): bigint =>
  BigInt(Math.round(value * Number(SCALE)));

/** Fetches with a deadline; a slow provider must not become a slow page. */
async function get(url: string, seconds = 6): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(seconds * 1000),
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Paper currencies, from a free daily reference.
 *
 * The provider answers "one base buys this much of X", and the office thinks in
 * the other direction — what one dollar costs in shekels — so each is inverted
 * on the way in. A currency the provider does not carry is simply absent; there
 * is no sensible invented value for it.
 */
async function fiat(base: string, wanted: string[]): Promise<MarketQuote[]> {
  const data = (await get(`https://open.er-api.com/v6/latest/${base}`)) as
    | { result?: string; rates?: Record<string, number>; time_last_update_unix?: number }
    | null;

  if (!data || data.result !== 'success' || !data.rates) return [];

  const asOf = new Date((data.time_last_update_unix ?? Date.now() / 1000) * 1000);

  return wanted.flatMap((code) => {
    const perBase = data.rates?.[code];
    if (!perBase || perBase <= 0) return [];
    return [{ code, rate: scaled(1 / perBase), asOf, cadence: 'DAILY' as const }];
  });
}

/** USDT, from a free source that actually moves during the day. */
async function tether(base: string): Promise<MarketQuote[]> {
  const vs = base.toLowerCase();
  const data = (await get(
    `https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=${vs}`,
  )) as { tether?: Record<string, number> } | null;

  const price = data?.tether?.[vs];
  if (!price || price <= 0) return [];

  return [{ code: 'USDT', rate: scaled(price), asOf: new Date(), cadence: 'LIVE' }];
}

/**
 * The market as it stands, for the currencies this office actually trades.
 *
 * Cached for as long as the manager says. Returns the previous answer rather
 * than an error when a source is unreachable, because a counter screen has no
 * use for the news that somebody else's server is down.
 */
export async function snapshot(db: DbClient = prisma): Promise<MarketSnapshot> {
  if (cache && cache.until > Date.now()) return cache.snapshot;

  const [base, minutes, currencies] = await Promise.all([
    baseCurrency(db),
    settings.getNumber('market.refreshMinutes').catch(() => 10),
    db.currency.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { code: true, kind: true },
    }),
  ]);

  const paper = currencies
    .filter((row) => row.kind !== 'CRYPTO' && row.code !== base)
    .map((row) => row.code);
  const hasTether = currencies.some((row) => row.code === 'USDT');

  const [fiatQuotes, tetherQuotes] = await Promise.all([
    paper.length > 0 ? fiat(base, paper) : Promise.resolve([]),
    hasTether ? tether(base) : Promise.resolve([]),
  ]);

  const quotes = [...fiatQuotes, ...tetherQuotes];

  // Everything failed. Keep showing the last good answer, marked as such.
  if (quotes.length === 0 && cache) {
    log.debug('Market unreachable; serving the last good answer');
    const stale = { ...cache.snapshot, stale: true };
    cache = { snapshot: stale, until: Date.now() + 60_000 };
    return stale;
  }

  const fresh: MarketSnapshot = {
    base,
    quotes,
    fetchedAt: new Date(),
    stale: quotes.length === 0,
  };

  cache = {
    snapshot: fresh,
    // A failed round is retried sooner than a good one is refreshed.
    until: Date.now() + (quotes.length === 0 ? 60_000 : Math.max(1, minutes) * 60_000),
  };

  log.debug('Market refreshed', { quotes: quotes.length });
  return fresh;
}

/** Forgets the cached answer. Used when the refresh interval is changed. */
export function forget(): void {
  cache = null;
}
