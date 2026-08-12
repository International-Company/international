'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';

/**
 * The market ticker across the top of every screen.
 *
 * The pairs an exchange office glances at all day — the shekel, the euro, the
 * lira, the pound, and gold by the ounce, which matters here because the
 * business is money *and jewellery*.
 *
 * ## Why it reads left to right in an Arabic interface
 *
 * A rate is a number and a pair of codes, and both are Latin. Running the strip
 * with the page would put `USD/ILS` beside a figure that belongs to its
 * neighbour, so the strip is forced `ltr` regardless of the interface language —
 * the same decision every amount in this system already makes.
 *
 * ## Why it moves
 *
 * There are more pairs than fit a phone. The alternatives were to cut the list
 * down until it fits the smallest screen, or to let it scroll — and a ticker
 * that scrolls is the form every trader already knows how to read. It pauses on
 * hover so a figure can actually be caught, and it does not move at all for
 * somebody who has asked their system for less motion.
 *
 * ## What it is not
 *
 * Not a price. The office quotes the board its manager publishes; this says
 * "market" at its head and nothing in the trading path can read it.
 */

interface Pair {
  pair: string;
  quote: string;
  rate: string;
  cadence: 'DAILY' | 'LIVE';
}

/** How often the browser asks. The server answers from its own cache. */
const POLL_MS = 120_000;

/**
 * Rates are read at a glance, so the precision follows the magnitude rather
 * than a fixed rule: four places on a currency pair, none on an ounce of gold
 * where the fourth decimal is noise beside a four-figure price.
 */
function show(scaled: string): string {
  const value = Number(BigInt(scaled)) / 1e8;
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (value >= 100) return value.toFixed(2);
  return value.toFixed(4);
}

export function MarketBar() {
  const { t } = useLocale();
  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ enabled: boolean; pairs: Pair[]; stale?: boolean }>('/api/market');
      setPairs(data.enabled ? data.pairs : []);
      setStale(Boolean(data.stale));
    } catch {
      // A ticker that shows an error has misunderstood its own importance.
      setPairs([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  if (pairs === null || pairs.length === 0) return null;

  return (
    <div
      dir="ltr"
      role="region"
      aria-label={t('market.title')}
      className="fixed inset-x-0 top-0 z-50 flex h-8 items-stretch overflow-hidden bg-[#111214] text-white/90"
    >
      {/*
        Pinned outside the scroll, so the word that stops this being read as a
        price is the one thing that never slides away.
      */}
      <span className="z-10 flex shrink-0 items-center gap-1.5 bg-[#111214] px-3 text-[10px] font-semibold tracking-widest text-white/45 uppercase shadow-[8px_0_8px_-8px_rgba(0,0,0,0.9)]">
        {stale && <span className="size-1.5 rounded-full bg-amber-400" aria-hidden />}
        {stale ? t('market.stale') : t('market.title')}
      </span>

      <div className="marquee flex min-w-0 flex-1 items-center">
        {/* Twice, so the second copy is entering as the first leaves. */}
        {[0, 1].map((copy) => (
          <div key={copy} className="marquee-track flex shrink-0 items-center" aria-hidden={copy === 1}>
            {pairs.map((row) => (
              <span
                key={`${copy}-${row.pair}`}
                className="flex items-center gap-2 border-e border-white/10 px-5 text-xs whitespace-nowrap"
              >
                <span className="font-semibold tracking-wide">{row.pair}</span>
                <span className="tabular-nums text-white/70">
                  {row.quote === 'USD' && Number(BigInt(row.rate)) / 1e8 >= 1000 ? '$' : ''}
                  {show(row.rate)}
                </span>
                {row.cadence === 'LIVE' && (
                  <span className="size-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
                )}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
