'use client';

import { useCallback, useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { formatDate } from '@/i18n/format';
import { Badge, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * A teller's days, one row each: what the machine exchanged, and what he owed
 * the bank of its own transfers when the day ended.
 *
 * ## Why each day's owed figure stands alone
 *
 * The office settles the bank day by day, so each day shows only its own
 * transfers still unsent when it ended — nothing carried in from the days
 * before, so one day's account never swells another's.
 *
 * ## Why each day can be sent
 *
 * The office closes its day on WhatsApp, not on this screen. One tap writes
 * the day out in plain lines, the same way every other message here is
 * written, and hands it to WhatsApp to send to whoever needs it.
 */

interface Amount {
  currency: string;
  amount: string;
}

interface LedgerDay {
  dayId: string;
  date: string;
  status: string;
  count: number;
  received: Amount[];
  paidCash: Amount[];
  paidBank: Amount[];
  owedAtEnd: Amount[];
}

/** The currency as the office writes it in a message. */
const SHORT_AR: Record<string, string> = { ILS: 'شيكل', USD: 'دولار', JOD: 'دينار', USDT: 'USDT' };

const decimalsOf = (currency: string) => (currency === 'JOD' ? 3 : 2);

/** A 1e8-scaled amount as a plain figure — whole amounts without ".00". */
function plain(scaled: string, currency: string): string {
  const value = BigInt(scaled || '0');
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const places = decimalsOf(currency);
  const unit = 10n ** BigInt(8 - places);
  const rounded = (abs + unit / 2n) / unit;
  const whole = rounded / 10n ** BigInt(places);
  const fraction = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = /^0+$/.test(fraction) ? grouped : `${grouped}.${fraction}`;
  return negative ? `-${text}` : text;
}

export function DailyLedger({
  days = 14,
  tellerId,
  title,
  refreshKey,
}: {
  days?: number;
  /** Another teller's days, for a manager. Omitted: the signed-in person's own. */
  tellerId?: string;
  title?: string;
  /** Changes whenever something is recorded, so the running day follows at once. */
  refreshKey?: string | number | null;
}) {
  const { t, locale } = useLocale();
  const [rows, setRows] = useState<LedgerDay[] | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ days: LedgerDay[] }>(
        `/api/my/days${queryString({ days, tellerId })}`,
      );
      setRows(result.days);
    } catch {
      setRows((current) => current ?? []);
    }
  }, [days, tellerId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const unit = (currency: string) =>
    locale === 'ar' ? (SHORT_AR[currency] ?? currency) : currency;
  const lines = (amounts: Amount[]) =>
    amounts.length === 0
      ? [t('ledgerDays.nothing')]
      : amounts.map((entry) => `${plain(entry.amount, entry.currency)} ${unit(entry.currency)}`);

  /** The day, written out the way the office sends things. */
  const message = (day: LedgerDay) =>
    [
      t('ledgerDays.shareTitle', { date: day.date }),
      t('ledgerDays.shareCount', { count: day.count }),
      '',
      `${t('ledgerDays.received')}:`,
      ...lines(day.received),
      '',
      `${t('ledgerDays.paidCash')}:`,
      ...lines(day.paidCash),
      '',
      `${t('ledgerDays.paidBank')}:`,
      ...lines(day.paidBank),
      '',
      t('ledgerDays.shareOwed'),
      ...lines(day.owedAtEnd),
    ].join('\n');

  // The newest day is the one being worked: its own transfers still unsent.
  const owedNow = (rows?.[0]?.owedAtEnd ?? []).filter((entry) => BigInt(entry.amount) !== 0n);
  const periodCount = (rows ?? []).reduce((sum, day) => sum + day.count, 0);

  return (
    <Card className="overflow-hidden">
      <CardHeader title={title ?? t('ledgerDays.title')} description={t('ledgerDays.hint')} />
      {rows === null ? (
        <CardBody>
          <EmptyState title={t('common.loading')} />
        </CardBody>
      ) : rows.length === 0 ? (
        <CardBody>
          <EmptyState title={t('ledgerDays.none')} />
        </CardBody>
      ) : (
        <div className="@container">
          {/* The one figure the day is reconciled against, before any detail. */}
          <div
            className={cn(
              'flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b border-border-base px-4 py-4',
              owedNow.length > 0 ? 'bg-warning-subtle/50' : 'bg-success-subtle/40',
            )}
          >
            <div className="min-w-0">
              <p className="text-xs font-medium text-content-secondary">
                {owedNow.length > 0 ? t('ledgerDays.owedNow') : t('ledgerDays.settled')}
              </p>
              {owedNow.length > 0 ? (
                <>
                  <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1">
                    {owedNow.map((entry) => (
                      <Money
                        key={entry.currency}
                        value={entry.amount}
                        currency={entry.currency}
                        decimals={decimalsOf(entry.currency)}
                        className="text-2xl font-semibold tracking-tight text-warning-text"
                      />
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] text-content-tertiary">
                    {t('ledgerDays.owedNowHint')}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-2xl font-semibold tracking-tight text-success-text">✓</p>
              )}
            </div>
            <p className="text-xs text-content-secondary">
              <span className="font-semibold tabular-nums text-content">{periodCount}</span>{' '}
              {opsWord(periodCount, locale)} · {t('ledgerDays.period', { days: rows.length })}
            </p>
          </div>

          <ol className="divide-y divide-border-subtle">
            {rows.map((day, index) => {
              const isToday =
                index === 0 && (day.status === 'OPEN' || day.status === 'REOPENED');
              const owed = day.owedAtEnd.filter((entry) => BigInt(entry.amount) !== 0n);
              const quiet = day.count === 0;
              // noon, so no time zone can move the calendar day
              const when = new Date(`${day.date}T12:00:00`);
              const part = (options: Intl.DateTimeFormatOptions) =>
                formatDate(when, locale, { year: undefined, month: undefined, day: undefined, ...options });
              return (
                <li
                  key={day.dayId}
                  className={cn(
                    'relative px-4 transition-colors hover:bg-surface-sunken/60',
                    quiet ? 'py-2' : 'py-3.5',
                    isToday && 'bg-primary-subtle/30',
                  )}
                >
                  {isToday && (
                    <span aria-hidden className="absolute inset-y-0 start-0 w-0.5 bg-primary" />
                  )}
                  <div className="flex items-center justify-between gap-3">
                    {/* the day */}
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className={cn(
                          'flex shrink-0 flex-col items-center justify-center rounded-lg border leading-none',
                          quiet ? 'size-9' : 'size-11',
                          isToday
                            ? 'border-primary-border bg-primary-subtle text-primary-text'
                            : 'border-border-base bg-surface-sunken text-content',
                          quiet && 'text-content-secondary',
                        )}
                      >
                        <span className={cn('font-semibold tabular-nums', quiet ? 'text-sm' : 'text-base')}>
                          {part({ day: 'numeric' })}
                        </span>
                        <span className="mt-0.5 text-[9px] text-content-tertiary">
                          {part({ month: 'short' })}
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="flex items-center gap-2">
                          <span
                            className={cn(
                              'truncate text-sm font-medium',
                              quiet ? 'text-content-secondary' : 'text-content',
                            )}
                          >
                            {part({ weekday: 'long' })}
                          </span>
                          {isToday && (
                            <Badge tone="primary" dot>
                              {t('ledgerDays.today')}
                            </Badge>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-content-tertiary">
                          {quiet ? (
                            t('ledgerDays.quiet')
                          ) : (
                            <>
                              <span className="tabular-nums">{day.count}</span>{' '}
                              {opsWord(day.count, locale)}
                            </>
                          )}
                        </p>
                      </div>
                    </div>

                    {/* what was owed when it ended, then the report */}
                    <div className="flex shrink-0 items-center gap-1">
                      <div className="text-end">
                        <p className="text-[10px] text-content-tertiary">{t('ledgerDays.owedShort')}</p>
                        {owed.length === 0 ? (
                          <p className="text-sm text-content-tertiary">—</p>
                        ) : (
                          owed.map((entry) => (
                            <Money
                              key={entry.currency}
                              value={entry.amount}
                              currency={entry.currency}
                              decimals={decimalsOf(entry.currency)}
                              className="block text-sm font-semibold text-warning-text"
                            />
                          ))
                        )}
                      </div>
                      {quiet && owed.length === 0 ? (
                        <span aria-hidden className="size-9" />
                      ) : (
                        <a
                          href={`https://wa.me/?text=${encodeURIComponent(message(day))}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={t('ledgerDays.share')}
                          aria-label={t('ledgerDays.share')}
                          className="inline-flex size-9 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-success-subtle hover:text-success-text"
                        >
                          <MessageCircle className="size-4" />
                        </a>
                      )}
                    </div>
                  </div>

                  {/* the day's movement, only where there was some */}
                  {!quiet && (
                    <dl className="mt-3 grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border-subtle bg-border-subtle @sm:grid-cols-3">
                      <Figure label={t('ledgerDays.received')} amounts={day.received} />
                      <Figure label={t('ledgerDays.paidCash')} amounts={day.paidCash} />
                      <Figure label={t('ledgerDays.paidBank')} amounts={day.paidBank} />
                    </dl>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Card>
  );
}

/** «عملية / عمليتان / عمليات» — the noun agreeing with its count, as Arabic does. */
function opsWord(count: number, locale: string): string {
  if (locale !== 'ar') return count === 1 ? 'operation' : 'operations';
  const tail = count % 100;
  if (count === 1) return 'عملية';
  if (count === 2) return 'عمليتان';
  if (tail >= 3 && tail <= 10) return 'عمليات';
  return 'عملية';
}

function Figure({ label, amounts }: { label: string; amounts: Amount[] }) {
  return (
    <div className="flex items-baseline justify-between gap-3 bg-surface px-3 py-2 @sm:block">
      <dt className="text-[11px] text-content-tertiary">{label}</dt>
      <dd className="text-end @sm:mt-0.5 @sm:text-start">
        {amounts.length === 0 ? (
          <span className="text-sm text-content-tertiary">—</span>
        ) : (
          amounts.map((entry) => (
            <Money
              key={entry.currency}
              value={entry.amount}
              currency={entry.currency}
              decimals={decimalsOf(entry.currency)}
              className="block text-sm font-medium text-content"
            />
          ))
        )}
      </dd>
    </div>
  );
}
