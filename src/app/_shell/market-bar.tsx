'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { cn } from '@/ui/utils';

/**
 * The market strip under the header.
 *
 * Each currency shows the office's own board first and the market beside it,
 * because those two figures are only interesting as a pair — the gap between
 * them is the office's margin, and it is the one number a manager wants at a
 * glance all day.
 *
 * Deliberately quiet. It sits in the flow of the layout rather than floating
 * over anything, it carries no controls, and it never grows: a strip that
 * demands attention every time a rate moves would be read for a week and
 * ignored for a year.
 *
 * It says how old each figure is, and does not pretend the two sources share a
 * freshness they do not — paper currencies come from a daily reference and USDT
 * from a live one.
 */

interface Row {
  code: string;
  market: string;
  asOf: string;
  cadence: 'DAILY' | 'LIVE';
  buy: string | null;
  sell: string | null;
}

/** How often the browser asks. The server answers from its own cache. */
const POLL_MS = 120_000;

const plain = (scaled: string, decimals = 4): string =>
  (Number(BigInt(scaled)) / 1e8).toFixed(decimals);

export function MarketBar() {
  const { t } = useLocale();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [stale, setStale] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ enabled: boolean; rows: Row[]; stale?: boolean }>('/api/market');
      setRows(data.enabled ? data.rows : []);
      setStale(Boolean(data.stale));
    } catch {
      // A market strip that shows an error has misunderstood its own importance.
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    // Asking again on return costs one request and saves reading a stale figure
    // after the phone has been in a pocket all morning.
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  if (rows === null || rows.length === 0) return null;

  return (
    <div
      className="border-border-base bg-surface-sunken/60 flex items-center gap-3 overflow-x-auto border-b px-3 py-1.5 sm:px-4"
      role="region"
      aria-label={t('market.title')}
    >
      {/*
        A legend rather than a repeated word. Naming the two columns once at the
        head lets every figure after it be read without a label of its own,
        which is what keeps the strip to one line.
      */}
      <span className="text-content-tertiary shrink-0 text-[10px] font-medium tracking-wide">
        {stale ? t('market.stale') : t('market.legend')}
      </span>

      {rows.map((row) => (
        <span
          key={row.code}
          className="flex shrink-0 items-baseline gap-1.5 text-xs whitespace-nowrap"
          title={`${t('market.asOf')} ${new Date(row.asOf).toLocaleString()}`}
        >
          <span className="text-content font-semibold ltr-content">{row.code}</span>

          {/* The office's own price leads. It is the one that is binding. */}
          {row.buy && row.sell ? (
            <span className="text-content tabular-nums ltr-content">
              {plain(row.buy, 4)} / {plain(row.sell, 4)}
            </span>
          ) : (
            <span className="text-warning-text">{t('market.noBoard')}</span>
          )}

          <span className="text-content-tertiary">·</span>

          <span className="text-content-secondary tabular-nums ltr-content">
            {plain(row.market, 4)}
          </span>

          {/* Only the live one is marked, because only it earns the word. */}
          {row.cadence === 'LIVE' && (
            <span
              className={cn('bg-success size-1.5 shrink-0 rounded-full', !stale && 'animate-pulse')}
              aria-hidden
            />
          )}
        </span>
      ))}
    </div>
  );
}
