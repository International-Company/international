'use client';

import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { Money } from '@/ui/display';
import type { Amount, SpecialPriceDeal } from '@/app/_activity/parts';

/**
 * Today's deals at a special price, on the machine itself.
 *
 * The teller's own, read from his report, so the figures are the ones the
 * manager sees on the activity screen. Shown only when there is one: a panel
 * that is empty most of the day is noise beside the machine.
 */
export function TodaySpecialPrices({ refreshKey }: { refreshKey?: string }) {
  const { t } = useLocale();
  const [deals, setDeals] = useState<SpecialPriceDeal[]>([]);
  const [conceded, setConceded] = useState<Amount[]>([]);

  useEffect(() => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    void api
      .get<{ specialPrices: SpecialPriceDeal[]; specialConceded: Amount[] }>(
        `/api/my/activity${queryString({ from: from.toISOString(), to: to.toISOString() })}`,
      )
      .then((report) => {
        setDeals(report.specialPrices ?? []);
        setConceded(report.specialConceded ?? []);
      })
      .catch(() => {
        setDeals([]);
        setConceded([]);
      });
  }, [refreshKey]);

  if (deals.length === 0) return null;

  const rate = (scaled: string) => (Number(BigInt(scaled)) / 1e8).toFixed(4);

  return (
    <section className="overflow-hidden rounded-2xl bg-surface ring-1 ring-warning-border">
      <header className="flex items-center justify-between gap-2 border-b border-border-subtle bg-warning-subtle px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-content">
          <Star className="size-4 text-warning-text" />
          {t('machine.specialToday')}
        </h3>
        <span className="text-xs font-semibold tabular-nums text-warning-text">
          {t('activity.operations', { count: deals.length })}
        </span>
      </header>
      <ul className="divide-y divide-border-subtle">
        {deals.map((deal) => (
          <li key={deal.id} className="space-y-0.5 px-4 py-2.5">
            <p className="ltr-content flex flex-wrap items-baseline gap-x-1.5 text-sm font-medium tabular-nums">
              <Money value={deal.fromAmount} currency={deal.fromCurrency} />
              <span className="text-content-tertiary">→</span>
              <Money value={deal.toAmount} currency={deal.toCurrency} />
            </p>
            <p className="flex flex-wrap items-center gap-x-3 text-[11px] text-content-secondary">
              <span>
                {t('activity.specialBoard')}{' '}
                <span className="tabular-nums ltr-content">{rate(deal.boardRate)}</span>
              </span>
              <span>
                {t('activity.specialGiven')}{' '}
                <span className="font-semibold text-content tabular-nums ltr-content">
                  {rate(deal.givenRate)}
                </span>
              </span>
              {deal.conceded && (
                <span className="text-danger-text">
                  {t('activity.specialCost')}{' '}
                  <Money value={deal.conceded.amount} currency={deal.conceded.currency} />
                </span>
              )}
              <span className="font-mono text-content-tertiary ltr-content">{deal.reference}</span>
            </p>
          </li>
        ))}
      </ul>
      {conceded.length > 0 && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-surface-sunken px-4 py-2 text-xs font-semibold">
          <span>{t('activity.specialTotal')}</span>
          <span className="flex flex-wrap gap-3 text-danger-text">
            {conceded.map((entry) => (
              <Money key={entry.currency} value={entry.amount} currency={entry.currency} />
            ))}
          </span>
        </footer>
      )}
    </section>
  );
}
