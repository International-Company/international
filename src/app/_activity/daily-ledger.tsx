'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, MessageCircle, Printer } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { formatDate } from '@/i18n/format';
import { Badge, Card, CardBody, CardHeader, EmptyState, LoadingRows } from '@/ui/primitives';
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
  page = false,
}: {
  days?: number;
  /** Another teller's days, for a manager. Omitted: the signed-in person's own. */
  tellerId?: string;
  title?: string;
  /** Changes whenever something is recorded, so the running day follows at once. */
  refreshKey?: string | number | null;
  /** The owed-today band at the top; off where the page already shows it. */
  summary?: boolean;
  /**
   * The days as a screen of their own: a range to choose, the period's figures
   * as tiles, and no card heading, because the page already carries the title.
   */
  page?: boolean;
}) {
  const { t, locale } = useLocale();
  const [rows, setRows] = useState<LedgerDay[] | null>(null);
  const [span, setSpan] = useState<number>(days);
  const [showQuiet, setShowQuiet] = useState(false);
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
        `/api/my/days${queryString({ days: span, tellerId })}`,
      );
      setRows(result.days);
    } catch {
      setRows((current) => current ?? []);
    }
  }, [span, tellerId]);

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
  const all = rows ?? [];
  const owedNow = (all[0]?.owedAtEnd ?? []).filter((entry) => BigInt(entry.amount) !== 0n);
  const periodCount = all.reduce((sum, day) => sum + day.count, 0);
  const activeDays = all.filter((day) => day.count > 0).length;
  const periodReceived = sumAll(all.map((day) => day.received));
  const periodBank = sumAll(all.map((day) => day.paidBank));

  // A day with nothing exchanged and nothing owed says nothing; it waits behind
  // one line instead of taking a row of its own.
  const isQuiet = (day: LedgerDay) =>
    day.count === 0 && !day.owedAtEnd.some((entry) => BigInt(entry.amount) !== 0n);
  const quietCount = all.filter(isQuiet).length;
  const shown = all.filter((day, index) => showQuiet || index === 0 || !isQuiet(day));

  // Grouped by month, newest first, as a calendar is read.
  const months: { key: string; label: string; days: LedgerDay[] }[] = [];
  for (const day of shown) {
    const key = day.date.slice(0, 7);
    let group = months[months.length - 1];
    if (!group || group.key !== key) {
      group = {
        key,
        label: formatDate(new Date(`${day.date}T12:00:00`), locale, {
          day: undefined,
          month: 'long',
          year: 'numeric',
        }),
        days: [],
      };
      months.push(group);
    }
    group.days.push(day);
  }

  const rangePicker = page && (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div
        role="radiogroup"
        aria-label={t('ledgerDays.range')}
        className="inline-flex rounded-full bg-surface-sunken p-1 ring-1 ring-border-subtle"
      >
        {RANGES.map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={span === option}
            onClick={() => setSpan(option)}
            className={cn(
              'h-9 rounded-full px-4 text-sm font-medium transition-colors',
              span === option
                ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                : 'text-content-tertiary hover:text-content-secondary',
            )}
          >
            {daysPhrase(option, locale)}
          </button>
        ))}
      </div>
      {quietCount > 0 && (
        <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-content-secondary">
          <input
            type="checkbox"
            checked={showQuiet}
            onChange={(event) => setShowQuiet(event.target.checked)}
            className="size-4 accent-[var(--color-primary)]"
          />
          {t('ledgerDays.showQuiet')}
        </label>
      )}
    </div>
  );

  const tiles = page && rows && rows.length > 0 && (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        tone={owedNow.length > 0 ? 'warning' : 'success'}
        label={owedNow.length > 0 ? t('ledgerDays.owedNow') : t('ledgerDays.settled')}
        hint={owedNow.length > 0 ? t('ledgerDays.owedNowHint') : undefined}
      >
        {owedNow.length > 0 ? <Amounts list={owedNow} /> : '✓'}
      </Tile>
      <Tile
        label={t('ledgerDays.periodOpsLabel')}
        hint={t('ledgerDays.activeDays', { count: activeDays })}
      >
        <span className="tabular-nums">{periodCount}</span>
      </Tile>
      <Tile label={t('ledgerDays.periodReceived')}>
        <Amounts list={periodReceived} />
      </Tile>
      <Tile label={t('ledgerDays.periodBank')}>
        <Amounts list={periodBank} />
      </Tile>
    </div>
  );

  const list = (
    <div className="@container">
      {months.map((month) => (
        <section key={month.key}>
          <h3 className="sticky top-[5.5rem] z-[1] flex items-center justify-between border-b border-border-subtle bg-surface/95 px-4 py-2 text-xs font-semibold text-content-secondary backdrop-blur">
            <span>{month.label}</span>
            <span className="font-normal tabular-nums text-content-tertiary">
              {month.days.reduce((sum, day) => sum + day.count, 0)}{' '}
              {opsWord(month.days.reduce((sum, day) => sum + day.count, 0), locale)}
            </span>
          </h3>
          <ol className="divide-y divide-border-subtle">
            {month.days.map((day) => (
              <DayRow
                key={day.dayId}
                day={day}
                isToday={day === all[0] && (day.status === 'OPEN' || day.status === 'REOPENED')}
                open={opened.has(day.dayId)}
                onToggle={() => toggle(day.dayId)}
                message={message(day)}
                tellerId={tellerId}
                refreshKey={refreshKey}
              />
            ))}
          </ol>
        </section>
      ))}

      {!page && quietCount > 0 && (
        <button
          type="button"
          onClick={() => setShowQuiet((value) => !value)}
          className="w-full border-t border-border-subtle px-4 py-2.5 text-xs font-medium text-primary-text transition-colors hover:bg-surface-sunken"
        >
          {showQuiet
            ? t('ledgerDays.hideQuiet')
            : t('ledgerDays.quietHidden', { days: daysPhrase(quietCount, locale) })}
        </button>
      )}
    </div>
  );

  const body =
    rows === null ? (
      <CardBody>
        <LoadingRows rows={4} columns={3} />
      </CardBody>
    ) : rows.length === 0 ? (
      <CardBody>
        <EmptyState title={t('ledgerDays.none')} />
      </CardBody>
    ) : (
      <>
        {/* The one figure the day is reconciled against, before any detail. */}
        {summary && !page && (
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
                  <div className="mt-1 text-2xl font-semibold tracking-tight text-warning-text">
                    <Amounts list={owedNow} />
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
              {opsWord(periodCount, locale)} ·{' '}
              {t('ledgerDays.period', { days: daysPhrase(all.length, locale) })}
            </p>
          </div>
        )}
        {list}
      </>
    );

  if (page) {
    return (
      <div className="space-y-4">
        {rangePicker}
        {tiles}
        <Card className="overflow-clip">{body}</Card>
      </div>
    );
  }

  return (
    <Card className="overflow-clip">
      <CardHeader title={title ?? t('ledgerDays.title')} description={t('ledgerDays.hint')} />
      {body}
    </Card>
  );
}

const RANGES = [7, 30, 90] as const;

/** Every day's amounts, added up per currency. */
function sumAll(lists: Amount[][]): Amount[] {
  const sums = new Map<string, bigint>();
  for (const list of lists) {
    for (const entry of list) {
      sums.set(entry.currency, (sums.get(entry.currency) ?? 0n) + BigInt(entry.amount));
    }
  }
  return [...sums]
    .filter(([, amount]) => amount !== 0n)
    .map(([currency, amount]) => ({ currency, amount: amount.toString() }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** «يوم واحد / يومان / ٣ أيام / ١١ يوماً» — the count of days as Arabic says it. */
function daysPhrase(count: number, locale: string): string {
  if (locale !== 'ar') return count === 1 ? '1 day' : `${count} days`;
  const tail = count % 100;
  if (count === 1) return 'يوم واحد';
  if (count === 2) return 'يومان';
  if (tail >= 3 && tail <= 10) return `${count} أيام`;
  return `${count} يوماً`;
}

function Amounts({ list }: { list: Amount[] }) {
  if (list.length === 0) return <span className="text-content-tertiary">—</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {list.map((entry) => (
        <Money
          key={entry.currency}
          value={entry.amount}
          currency={entry.currency}
          decimals={decimalsOf(entry.currency)}
        />
      ))}
    </span>
  );
}

function Tile({
  label,
  hint,
  tone,
  children,
}: {
  label: string;
  hint?: string;
  tone?: 'warning' | 'success';
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl p-4 ring-1',
        tone === 'warning'
          ? 'bg-warning-subtle/60 ring-warning-border'
          : tone === 'success'
            ? 'bg-success-subtle/50 ring-success-border'
            : 'bg-surface ring-border-subtle',
      )}
    >
      <p className="text-xs font-medium text-content-secondary">{label}</p>
      <div
        className={cn(
          'mt-1.5 text-xl font-semibold tracking-tight',
          tone === 'warning'
            ? 'text-warning-text'
            : tone === 'success'
              ? 'text-success-text'
              : 'text-content',
        )}
      >
        {children}
      </div>
      {hint && <p className="mt-1 text-[11px] text-content-tertiary">{hint}</p>}
    </div>
  );
}

/**
 * One day: the whole row opens it, so there is no small target to aim at —
 * only the WhatsApp report sits apart, because it does something else.
 */
function DayRow({
  day,
  isToday,
  open,
  onToggle,
  message,
  tellerId,
  refreshKey,
}: {
  day: LedgerDay;
  isToday: boolean;
  open: boolean;
  onToggle: () => void;
  message: string;
  tellerId?: string;
  refreshKey?: string | number | null;
}) {
  const { t, locale } = useLocale();
  const owed = day.owedAtEnd.filter((entry) => BigInt(entry.amount) !== 0n);
  const quiet = day.count === 0;
  // noon, so no time zone can move the calendar day
  const when = new Date(`${day.date}T12:00:00`);
  const part = (options: Intl.DateTimeFormatOptions) =>
    formatDate(when, locale, { year: undefined, month: undefined, day: undefined, ...options });

  return (
    <li
      className={cn(
        'relative transition-colors',
        isToday && 'bg-primary-subtle/25',
        open && !isToday && 'bg-surface-sunken/40',
      )}
    >
      {isToday && <span aria-hidden className="absolute inset-y-0 start-0 w-0.5 bg-primary" />}

      <div className="flex items-stretch">
        <button
          type="button"
          disabled={quiet}
          onClick={onToggle}
          aria-expanded={quiet ? undefined : open}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-3 px-4 text-start outline-none',
            'focus-visible:bg-surface-sunken disabled:cursor-default',
            quiet ? 'py-2.5' : 'py-3 hover:bg-surface-sunken/60',
          )}
        >
          <span
            className={cn(
              'flex shrink-0 flex-col items-center justify-center rounded-xl border leading-none',
              quiet ? 'size-10' : 'size-12',
              isToday
                ? 'border-primary-border bg-primary-subtle text-primary-text'
                : 'border-border-base bg-surface text-content',
              quiet && 'text-content-tertiary',
            )}
          >
            <span className={cn('font-semibold tabular-nums', quiet ? 'text-sm' : 'text-lg')}>
              {part({ day: 'numeric' })}
            </span>
            <span className="mt-0.5 text-[9px] text-content-tertiary">{part({ month: 'short' })}</span>
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'truncate text-sm font-semibold',
                  quiet ? 'text-content-tertiary' : 'text-content',
                )}
              >
                {part({ weekday: 'long' })}
              </span>
              {isToday && (
                <Badge tone="primary" dot>
                  {t('ledgerDays.today')}
                </Badge>
              )}
            </span>
            <span className="mt-0.5 block text-xs text-content-tertiary">
              {quiet ? (
                t('ledgerDays.quiet')
              ) : (
                <>
                  <span className="tabular-nums">{day.count}</span> {opsWord(day.count, locale)}
                </>
              )}
            </span>
          </span>

          <span className="shrink-0 text-end">
            <span className="block text-[10px] text-content-tertiary">{t('ledgerDays.owedShort')}</span>
            <span
              className={cn(
                'block text-sm',
                owed.length > 0 ? 'font-semibold text-warning-text' : 'text-content-tertiary',
              )}
            >
              <Amounts list={owed} />
            </span>
          </span>

          {!quiet && (
            <ChevronDown
              aria-hidden
              className={cn(
                'size-5 shrink-0 text-content-tertiary transition-transform duration-200',
                open && 'rotate-180 text-primary-text',
              )}
            />
          )}
        </button>

        <span className="flex shrink-0 items-center pe-2">
          {quiet && owed.length === 0 ? (
            <span aria-hidden className="size-9" />
          ) : (
            <a
              href={`https://wa.me/?text=${encodeURIComponent(message)}`}
              target="_blank"
              rel="noopener noreferrer"
              title={t('ledgerDays.share')}
              aria-label={t('ledgerDays.share')}
              className="inline-flex size-9 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-success-subtle hover:text-success-text"
            >
              <MessageCircle className="size-4" />
            </a>
          )}
        </span>
      </div>

      {/* the day's movement, only where there was some */}
      {!quiet && (
        <div className="px-4 pb-3">
          <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border-subtle bg-border-subtle @sm:grid-cols-3">
            <Figure label={t('ledgerDays.received')} amounts={day.received} />
            <Figure label={t('ledgerDays.paidCash')} amounts={day.paidCash} />
            <Figure label={t('ledgerDays.paidBank')} amounts={day.paidBank} />
          </dl>
          {open && <DayDetail dayId={day.dayId} tellerId={tellerId} refreshKey={refreshKey} />}
        </div>
      )}
    </li>
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
