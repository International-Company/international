'use client';

import { useCallback, useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { Badge } from '@/ui/primitives';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * جرد عملياتي — the teller's own box for a day, from zero.
 *
 * Opening at zero, then what he bought and sold, then every deal with the
 * notes it moved and the box after it, then the closing figure the drawer is
 * counted against. The running box is the point: when the count is off, the
 * line where it goes wrong is the deal to look at.
 */

interface Amount {
  currency: string;
  amount: string;
}

interface Entry {
  id: string;
  reference: string;
  type: string;
  at: string;
  side: 'BUY' | 'SELL' | 'CROSS' | 'OTHER';
  foreign: Amount | null;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  cashIn: Amount[];
  cashOut: Amount[];
  running: Amount[];
  reversal: boolean;
  reversed: boolean;
}

interface Ledger {
  opening: Amount[];
  closing: Amount[];
  traded: { currency: string; bought: string; sold: string; buys: number; sells: number }[];
  entries: Entry[];
}

type Filter = 'ALL' | 'BUY' | 'SELL';

const dayInput = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

/** Shekels per unit of the foreign side, read off the amounts themselves. */
function priceOf(entry: Entry): string | null {
  const from = Number(entry.fromAmount);
  const to = Number(entry.toAmount);
  if (!from || !to) return null;
  if (entry.side === 'BUY') return (to / from).toFixed(4);
  if (entry.side === 'SELL') return (from / to).toFixed(4);
  return null;
}

export function MyCashLedger({ refreshKey }: { refreshKey?: string }) {
  const { t } = useLocale();
  const [day, setDay] = useState(() => dayInput(new Date()));
  const [filter, setFilter] = useState<Filter>('ALL');
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    const from = new Date(year, month - 1, date);
    const to = new Date(year, month - 1, date, 23, 59, 59, 999);
    setLoading(true);
    try {
      setLedger(
        await api.get<Ledger>(
          `/api/my/cash-ledger${queryString({ from: from.toISOString(), to: to.toISOString() })}`,
        ),
      );
    } catch {
      setLedger(null);
    } finally {
      setLoading(false);
    }
  }, [day]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const entries = (ledger?.entries ?? []).filter(
    (entry) => filter === 'ALL' || entry.side === filter,
  );

  const sideBadge = (entry: Entry) => {
    if (entry.side === 'BUY') return <Badge tone="success">{t('cashLedger.buy')}</Badge>;
    if (entry.side === 'SELL') return <Badge tone="primary">{t('cashLedger.sell')}</Badge>;
    return <Badge tone="neutral">{t(`transactions.type.${entry.type}` as never)}</Badge>;
  };

  const amounts = (list: Amount[], tone?: string) =>
    list.length === 0 ? (
      <span className="text-content-tertiary">—</span>
    ) : (
      list.map((entry) => (
        <span key={entry.currency} className={cn('block', tone)}>
          <Money value={entry.amount} currency={entry.currency} />
        </span>
      ))
    );

  return (
    <section className="mt-6 space-y-4 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
      {/* --- Heading and the day ---------------------------------------- */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-content">
            <ClipboardList className="size-5 text-primary-text" />
            {t('cashLedger.title')}
          </h2>
          <p className="text-xs text-content-secondary">{t('cashLedger.hint')}</p>
        </div>
        <input
          type="date"
          value={day}
          max={dayInput(new Date())}
          onChange={(event) => event.target.value && setDay(event.target.value)}
          aria-label={t('cashLedger.day')}
          className="h-9 rounded-[var(--radius-control)] border border-border-base bg-surface px-2 text-sm"
        />
      </header>

      {loading && !ledger ? (
        <p className="py-6 text-center text-sm text-content-tertiary">{t('common.loading')}</p>
      ) : !ledger || ledger.entries.length === 0 ? (
        <p className="py-6 text-center text-sm text-content-tertiary">{t('cashLedger.empty')}</p>
      ) : (
        <>
          {/* --- Opening, traded, closing ------------------------------------ */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-surface-sunken p-3">
              <p className="text-xs font-medium text-content-secondary">
                {t('cashLedger.opening')}
              </p>
              <div className="mt-1 text-lg font-bold tabular-nums">{amounts(ledger.opening)}</div>
              <p className="mt-1 text-[11px] text-content-tertiary">
                {t('cashLedger.openingHint')}
              </p>
            </div>

            <div className="rounded-xl bg-surface-sunken p-3">
              <p className="text-xs font-medium text-content-secondary">{t('cashLedger.traded')}</p>
              {ledger.traded.length === 0 ? (
                <p className="mt-1 text-sm text-content-tertiary">—</p>
              ) : (
                <dl className="mt-1 space-y-1.5 text-sm">
                  {ledger.traded.map((row) => (
                    <div key={row.currency} className="space-y-0.5">
                      <div className="flex justify-between gap-2">
                        <dt className="text-success-text">
                          {t('cashLedger.bought', { count: row.buys })}
                        </dt>
                        <dd className="font-semibold tabular-nums">
                          <Money value={row.bought} currency={row.currency} />
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-primary-text">
                          {t('cashLedger.sold', { count: row.sells })}
                        </dt>
                        <dd className="font-semibold tabular-nums">
                          <Money value={row.sold} currency={row.currency} />
                        </dd>
                      </div>
                    </div>
                  ))}
                </dl>
              )}
            </div>

            <div className="rounded-xl bg-primary-subtle p-3 ring-1 ring-primary/30">
              <p className="text-xs font-medium text-content-secondary">
                {t('cashLedger.closing')}
              </p>
              <div className="mt-1 text-lg font-bold tabular-nums">{amounts(ledger.closing)}</div>
              <p className="mt-1 text-[11px] text-content-tertiary">
                {t('cashLedger.closingHint')}
              </p>
            </div>
          </div>

          {/* --- The deals, filtered ------------------------------------------ */}
          <div className="flex gap-1 rounded-full bg-surface-sunken p-1">
            {(['ALL', 'BUY', 'SELL'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                className={cn(
                  'flex-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
                  filter === option
                    ? 'bg-surface text-content shadow-sm'
                    : 'text-content-secondary hover:text-content',
                )}
              >
                {t(`cashLedger.filter.${option}`)}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="bg-surface-sunken text-xs text-content-secondary">
                  <th className="px-2 py-2 text-start font-medium">{t('cashLedger.colTime')}</th>
                  <th className="px-2 py-2 text-start font-medium">{t('cashLedger.colDeal')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colAmount')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colPrice')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colIn')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colOut')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colBox')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const struck = entry.reversed || entry.reversal;
                  return (
                    <tr
                      key={entry.id}
                      className={cn(
                        'border-t border-border-subtle align-top',
                        struck && 'bg-danger-subtle/20',
                      )}
                    >
                      <td className="px-2 py-2 tabular-nums ltr-content">
                        {new Date(entry.at).toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap items-center gap-1">
                          {sideBadge(entry)}
                          {entry.reversal && (
                            <Badge tone="danger">{t('cashLedger.reversal')}</Badge>
                          )}
                          {entry.reversed && (
                            <Badge tone="danger">{t('machine.deletedBadge')}</Badge>
                          )}
                        </div>
                        <span className="mt-0.5 block font-mono text-[11px] text-content-tertiary ltr-content">
                          {entry.reference}
                        </span>
                      </td>
                      <td
                        className={cn(
                          'px-2 py-2 text-end font-semibold tabular-nums',
                          struck && 'text-content-tertiary line-through',
                        )}
                      >
                        {entry.foreign ? (
                          <Money value={entry.foreign.amount} currency={entry.foreign.currency} />
                        ) : (
                          <Money value={entry.fromAmount} currency={entry.fromCurrency} />
                        )}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums ltr-content">
                        {priceOf(entry) ?? '—'}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">
                        {amounts(entry.cashIn, 'text-success-text')}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">
                        {amounts(entry.cashOut, 'text-danger-text')}
                      </td>
                      <td className="px-2 py-2 text-end text-xs font-semibold tabular-nums">
                        {amounts(entry.running)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
