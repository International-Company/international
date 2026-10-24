'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, MessageCircle, Printer } from 'lucide-react';
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
  summary = true,
}: {
  days?: number;
  /** Another teller's days, for a manager. Omitted: the signed-in person's own. */
  tellerId?: string;
  title?: string;
  /** Changes whenever something is recorded, so the running day follows at once. */
  refreshKey?: string | number | null;
  /** The owed-today band at the top; off where the page already shows it. */
  summary?: boolean;
}) {
  const { t, locale } = useLocale();
  const [rows, setRows] = useState<LedgerDay[] | null>(null);
  /** The days opened to their exchanges. */
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const toggle = (dayId: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (next.has(dayId)) next.delete(dayId);
      else next.add(dayId);
      return next;
    });

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
          {summary && (
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
          )}

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
                    {/* the day — tapped, it opens to the exchanges behind it */}
                    <button
                      type="button"
                      disabled={quiet}
                      onClick={() => toggle(day.dayId)}
                      aria-expanded={quiet ? undefined : opened.has(day.dayId)}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default"
                    >
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
                              <span className="ms-2 text-primary-text">
                                {opened.has(day.dayId)
                                  ? t('ledgerDays.hideDetail')
                                  : t('ledgerDays.showDetail')}
                              </span>
                            </>
                          )}
                        </p>
                      </div>
                      {!quiet && (
                        <ChevronDown
                          aria-hidden
                          className={cn(
                            'ms-auto size-4 shrink-0 text-content-tertiary transition-transform duration-200',
                            opened.has(day.dayId) && 'rotate-180',
                          )}
                        />
                      )}
                    </button>

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

                  {!quiet && opened.has(day.dayId) && (
                    <DayDetail dayId={day.dayId} tellerId={tellerId} refreshKey={refreshKey} />
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

interface DayEntry {
  id: string;
  reference: string;
  createdAt: string;
  status: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  payoutCashAmount: string;
  payoutBankAmount: string;
  payoutBankChannel: string | null;
  transferConfirmedAt: string | null;
  party: { en: string | null; ar: string | null };
}

/**
 * The exchanges behind one day, oldest first — fetched only when the day is
 * opened, so a month of days costs one request until someone asks for more.
 */
function DayDetail({
  dayId,
  tellerId,
  refreshKey,
}: {
  dayId: string;
  tellerId?: string;
  refreshKey?: string | number | null;
}) {
  const { t, locale } = useLocale();
  const [entries, setEntries] = useState<DayEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    api
      .get<{ entries: DayEntry[] }>(`/api/my/days/${dayId}${queryString({ tellerId })}`)
      .then((result) => live && setEntries(result.entries))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [dayId, tellerId, refreshKey]);

  const clock = (value: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));

  if (failed) {
    return <p className="mt-3 text-xs text-danger-text">{t('ledgerDays.detailFailed')}</p>;
  }
  if (entries === null) {
    return (
      <div className="mt-3 space-y-2" aria-busy>
        {[0, 1].map((key) => (
          <div key={key} className="h-12 animate-pulse rounded-lg bg-surface-sunken" />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-border-subtle">
      <p className="border-b border-border-subtle bg-surface-sunken px-3 py-1.5 text-[11px] font-medium text-content-secondary">
        {t('ledgerDays.detailTitle', { count: entries.length })}
      </p>
      <ul className="divide-y divide-border-subtle">
        {entries.map((entry) => {
          const gone = entry.status === 'REVERSED';
          const bank = BigInt(entry.payoutBankAmount) > 0n;
          const cash = BigInt(entry.payoutCashAmount) > 0n;
          const how = bank && cash ? 'split' : bank ? 'bank' : 'cash';
          const party = locale === 'ar' ? entry.party.ar : (entry.party.en ?? entry.party.ar);
          return (
            <li
              key={entry.id}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5',
                gone && 'bg-danger-subtle/20',
              )}
            >
              <span className="w-11 shrink-0 text-xs font-medium tabular-nums text-content-secondary ltr-content">
                {clock(entry.createdAt)}
              </span>

              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'ltr-content flex flex-wrap items-baseline gap-x-1.5 text-sm font-medium tabular-nums',
                    gone ? 'text-content-tertiary line-through decoration-danger/60' : 'text-content',
                  )}
                >
                  <Money
                    value={entry.fromAmount}
                    currency={entry.fromCurrency}
                    decimals={decimalsOf(entry.fromCurrency)}
                  />
                  <span className="text-content-tertiary">→</span>
                  <Money
                    value={entry.toAmount}
                    currency={entry.toCurrency}
                    decimals={decimalsOf(entry.toCurrency)}
                  />
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-content-tertiary">
                  <span>
                    {t(`ledgerDays.how.${how}`)}
                    {bank && entry.payoutBankChannel ? ` · ${entry.payoutBankChannel}` : ''}
                  </span>
                  {party && <span className="truncate">{party}</span>}
                  <span className="font-mono ltr-content">{entry.reference}</span>
                </p>
              </div>

              <span className="flex shrink-0 items-center gap-1">
                {gone ? (
                  <Badge tone="danger">{t('ledgerDays.state.deleted')}</Badge>
                ) : bank ? (
                  entry.transferConfirmedAt ? (
                    <Badge tone="success">{t('ledgerDays.state.sent')}</Badge>
                  ) : (
                    <Badge tone="warning">{t('ledgerDays.state.pending')}</Badge>
                  )
                ) : null}
                <a
                  href={`/print/receipt/${entry.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={t('transactions.printReceipt')}
                  aria-label={t('transactions.printReceipt')}
                  className="inline-flex size-8 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content"
                >
                  <Printer className="size-4" />
                </a>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
