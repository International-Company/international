'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  Printer,
  Search,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { formatDate } from '@/i18n/format';
import { api } from '@/lib/api-client';
import { normalizeDigits } from '@/core/money/money';
import { Badge, Card, EmptyState, LoadingRows } from '@/ui/primitives';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';
import {
  Amounts,
  dayReport,
  decimalsOf,
  opsWord,
  Tile,
  type DayEntry,
  type LedgerDay,
} from '@/app/_activity/daily-ledger';
import { MyCashLedger } from '../machine/my-cash-ledger';

/**
 * «أيام العمل» — one day at a time, chosen from a calendar.
 *
 * ## Why one day, not a list of them
 *
 * The question asked of this screen is always about a day: "what did I do on
 * Thursday", "what was owed that evening", "where is the 900 dollars". A list
 * of thirty days answers it only after scrolling and opening; a calendar with
 * the worked days marked answers it in one tap, and the day then gets the
 * whole screen — its figures, and every exchange in it, filterable.
 *
 * The calendar reaches back over the last ninety business days, which is the
 * most the days endpoint serves; a day outside that is simply not marked.
 */

const HISTORY = 90;

/** A calendar date as the server writes it: `YYYY-MM-DD`, local. */
function keyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fromKey(key: string): Date {
  // noon, so no time zone can move the calendar day
  return new Date(`${key}T12:00:00`);
}

type Filter = 'all' | 'cash' | 'bank' | 'pending' | 'deleted';
type How = 'cash' | 'bank' | 'split';

/**
 * An amount the ways it may be typed into the search: whole ("2030"), with
 * its fraction ("290.01"), or with the fraction's zeros dropped ("290.5").
 */
function amountForms(scaled: string): string[] {
  const value = BigInt(scaled || '0');
  const whole = (value / 100_000_000n).toString();
  const cents = ((value % 100_000_000n) / 1_000_000n).toString().padStart(2, '0');
  return [whole, `${whole}.${cents}`, `${whole}.${cents.replace(/0+$/, '')}`];
}

/**
 * What the teller typed, made comparable: Arabic-Indic digits become Western
 * (an Arabic keyboard types ٧٠٠, the books hold 700), thousands commas go,
 * an Arabic decimal mark becomes a point, and case is ignored.
 */
function normalise(text: string): string {
  return normalizeDigits(text)
    .replace(/[٫]/g, '.')
    .replace(/[,٬\s]/g, '')
    .toLowerCase();
}

/** Whether an exchange is the one being looked for. */
function found(entry: DayEntry, raw: string): boolean {
  const needle = normalise(raw);
  if (!needle) return true;
  const digits = needle.replace(/\D/g, '');

  const text = [entry.reference, entry.party.ar, entry.party.en, entry.payoutBankChannel]
    .filter(Boolean)
    .map((value) => normalise(value!));
  if (text.some((value) => value.includes(needle))) return true;

  // A telephone, however it was written down: 0592946938, +970 59 294 6938,
  // 00972-59…. Compared without the country code or the leading zero, so the
  // local form finds the international one and back.
  const local = (value: string) => value.replace(/^(00|\+)?(970|972)/, '').replace(/^0/, '');
  if (digits.length >= 3 && entry.phone) {
    const phone = local(normalise(entry.phone).replace(/[^\d+]/g, '')).replace(/\D/g, '');
    if (phone.includes(local(digits))) return true;
  }

  // an amount, on either side or either leg of a split
  const amounts = [
    entry.fromAmount,
    entry.toAmount,
    entry.payoutCashAmount,
    entry.payoutBankAmount,
  ].filter((value) => BigInt(value || '0') > 0n);
  return amounts.some((value) => amountForms(value).some((form) => form.startsWith(needle)));
}

export function WorkDaysView({ initialDate }: { initialDate?: string }) {
  const { t, locale } = useLocale();
  const todayKey = keyOf(new Date());

  const [days, setDays] = useState<LedgerDay[] | null>(null);
  const [selected, setSelected] = useState<string>(initialDate ?? todayKey);
  const [month, setMonth] = useState(() => {
    const at = fromKey(initialDate ?? todayKey);
    return { year: at.getFullYear(), month: at.getMonth() };
  });
  const [entries, setEntries] = useState<DayEntry[] | null>(null);
  const [entriesFailed, setEntriesFailed] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  // --- The days, once -------------------------------------------------------
  useEffect(() => {
    api
      .get<{ days: LedgerDay[] }>(`/api/my/days?days=${HISTORY}`)
      .then((result) => setDays(result.days))
      .catch(() => setDays([]));
  }, []);

  const byDate = useMemo(() => new Map((days ?? []).map((day) => [day.date, day])), [days]);
  const day = byDate.get(selected) ?? null;

  /** Worked days, oldest first — what "previous" and "next" step through. */
  const worked = useMemo(
    () => (days ?? []).filter((entry) => entry.count > 0).map((entry) => entry.date).sort(),
    [days],
  );
  const previous = [...worked].reverse().find((date) => date < selected) ?? null;
  const next = worked.find((date) => date > selected) ?? null;

  // --- The chosen day's exchanges --------------------------------------------
  const loadEntries = useCallback(async (dayId: string) => {
    setEntries(null);
    setEntriesFailed(false);
    try {
      const result = await api.get<{ entries: DayEntry[] }>(`/api/my/days/${dayId}`);
      setEntries(result.entries);
    } catch {
      setEntriesFailed(true);
    }
  }, []);

  useEffect(() => {
    if (day && day.count > 0) void loadEntries(day.dayId);
    else setEntries([]);
  }, [day, loadEntries]);

  const choose = (key: string) => {
    setSelected(key);
    setFilter('all');
    setSearch('');
    const at = fromKey(key);
    setMonth({ year: at.getFullYear(), month: at.getMonth() });
    // The chosen day in the address, so it can be reloaded or sent as a link.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('date', key);
      window.history.replaceState(null, '', url);
    } catch {
      // the address is a convenience; the screen works without it
    }
  };

  // --- Filtering --------------------------------------------------------------
  const kind = (entry: DayEntry): How => {
    const bank = BigInt(entry.payoutBankAmount) > 0n;
    const cash = BigInt(entry.payoutCashAmount) > 0n;
    return bank && cash ? 'split' : bank ? 'bank' : 'cash';
  };
  const matches = (entry: DayEntry, which: Filter) => {
    const gone = entry.status === 'REVERSED';
    switch (which) {
      case 'all':
        return true;
      case 'deleted':
        return gone;
      case 'cash':
        return !gone && kind(entry) === 'cash';
      case 'bank':
        return !gone && kind(entry) !== 'cash';
      case 'pending':
        return !gone && kind(entry) !== 'cash' && !entry.transferConfirmedAt;
    }
  };
  const visible = (entries ?? []).filter(
    (entry) => matches(entry, filter) && found(entry, search),
  );
  const counts: Record<Filter, number> = {
    all: entries?.length ?? 0,
    cash: (entries ?? []).filter((entry) => matches(entry, 'cash')).length,
    bank: (entries ?? []).filter((entry) => matches(entry, 'bank')).length,
    pending: (entries ?? []).filter((entry) => matches(entry, 'pending')).length,
    deleted: (entries ?? []).filter((entry) => matches(entry, 'deleted')).length,
  };

  const when = fromKey(selected);
  const owed = (day?.owedAtEnd ?? []).filter((entry) => BigInt(entry.amount) !== 0n);
  const isToday = selected === todayKey;
  const clock = (value: string) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));

  // In RTL "previous" points right, so the arrows follow the reading order.
  const BackArrow = locale === 'ar' ? ChevronRight : ChevronLeft;
  const ForwardArrow = locale === 'ar' ? ChevronLeft : ChevronRight;

  return (
    <div className="@container">
      <div className="grid gap-4 @4xl:grid-cols-[20rem_minmax(0,1fr)] @4xl:items-start">
        {/* ================= The calendar ================= */}
        <aside className="space-y-3 @4xl:sticky @4xl:top-[6.5rem]">
          <Card className="p-3">
            <MonthCalendar
              year={month.year}
              month={month.month}
              onMonth={(year, value) => setMonth({ year, month: value })}
              selected={selected}
              todayKey={todayKey}
              byDate={byDate}
              onChoose={choose}
              loading={days === null}
            />
          </Card>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-content-tertiary">
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary" /> {t('workDays.legendWorked')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-warning" /> {t('workDays.legendOwed')}
            </span>
          </div>
        </aside>

        {/* ================= The day ================= */}
        <section className="min-w-0 space-y-4">
          {/* the day, and stepping between worked days */}
          <Card className="flex flex-wrap items-center justify-between gap-3 p-3">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className={cn(
                  'flex size-14 shrink-0 flex-col items-center justify-center rounded-2xl border leading-none',
                  isToday
                    ? 'border-primary-border bg-primary-subtle text-primary-text'
                    : 'border-border-base bg-surface-sunken text-content',
                )}
              >
                <span className="text-xl font-bold tabular-nums">
                  {formatDate(when, locale, { day: 'numeric', month: undefined, year: undefined })}
                </span>
                <span className="mt-1 text-[10px] text-content-tertiary">
                  {formatDate(when, locale, { day: undefined, month: 'short', year: undefined })}
                </span>
              </span>
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-lg font-semibold text-content">
                  {formatDate(when, locale, {
                    weekday: 'long',
                    day: undefined,
                    month: undefined,
                    year: undefined,
                  })}
                  {isToday && (
                    <Badge tone="primary" dot>
                      {t('ledgerDays.today')}
                    </Badge>
                  )}
                </h2>
                <p className="text-sm text-content-secondary">
                  {formatDate(when, locale, { day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <StepButton
                onClick={() => previous && choose(previous)}
                disabled={!previous}
                label={t('workDays.previous')}
              >
                <BackArrow className="size-4" />
              </StepButton>
              <button
                type="button"
                onClick={() => choose(todayKey)}
                disabled={isToday}
                className="h-9 rounded-full px-3 text-sm font-medium text-primary-text transition-colors hover:bg-primary-subtle disabled:text-content-tertiary disabled:hover:bg-transparent"
              >
                {t('ledgerDays.today')}
              </button>
              <StepButton
                onClick={() => next && choose(next)}
                disabled={!next}
                label={t('workDays.next')}
              >
                <ForwardArrow className="size-4" />
              </StepButton>
              {day && day.count > 0 && (
                <a
                  href={`https://wa.me/?text=${encodeURIComponent(dayReport(day, t, locale))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ms-1 inline-flex h-9 items-center gap-1.5 rounded-full bg-success-subtle px-3 text-sm font-medium text-success-text transition-colors hover:brightness-95"
                >
                  <MessageCircle className="size-4" />
                  <span className="hidden @lg:inline">{t('ledgerDays.share')}</span>
                </a>
              )}
            </div>
          </Card>

          {/*
            The box for this day: what the teller opened it with, every buy and
            sell with the box after it, and the closing figure to count by.
          */}
          <MyCashLedger day={selected} className="mt-0" />

          {days === null ? (
            <Card className="p-4">
              <LoadingRows rows={4} columns={3} />
            </Card>
          ) : !day || day.count === 0 ? (
            <Card className="p-2">
              <EmptyState
                title={t('workDays.emptyTitle')}
                description={
                  owed.length > 0 ? undefined : t('workDays.emptyHint')
                }
              />
            </Card>
          ) : (
            <>
              {/* the day's figures */}
              <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3 @5xl:grid-cols-5">
                <Tile label={t('workDays.operations')}>
                  <span className="tabular-nums">{day.count}</span>{' '}
                  <span className="text-sm font-medium text-content-secondary">
                    {opsWord(day.count, locale)}
                  </span>
                </Tile>
                <Tile label={t('ledgerDays.received')}>
                  <Amounts list={day.received} />
                </Tile>
                <Tile label={t('ledgerDays.paidCash')}>
                  <Amounts list={day.paidCash} />
                </Tile>
                <Tile label={t('ledgerDays.paidBank')}>
                  <Amounts list={day.paidBank} />
                </Tile>
                <Tile
                  tone={owed.length > 0 ? 'warning' : 'success'}
                  label={t('ledgerDays.owed')}
                  hint={t('ledgerDays.owedHint')}
                >
                  {owed.length > 0 ? <Amounts list={owed} /> : '✓'}
                </Tile>
              </div>

              {/* every exchange in it */}
              <Card className="overflow-clip">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-base px-4 py-3">
                  <h3 className="text-sm font-semibold text-content">{t('workDays.entries')}</h3>
                  <label className="relative block w-full @lg:w-72">
                    <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-content-tertiary" />
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t('workDays.search')}
                      className="h-9 w-full rounded-full bg-surface-sunken ps-9 pe-3 text-sm text-content outline-none ring-1 ring-transparent placeholder:text-content-tertiary focus:ring-primary"
                    />
                  </label>
                </div>

                <div className="flex gap-1.5 overflow-x-auto border-b border-border-subtle px-4 py-2.5">
                  {(['all', 'cash', 'bank', 'pending', 'deleted'] as const).map((option) =>
                    option !== 'all' && counts[option] === 0 ? null : (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setFilter(option)}
                        aria-pressed={filter === option}
                        className={cn(
                          'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium ring-1 transition-colors',
                          filter === option
                            ? 'bg-primary text-white ring-primary'
                            : 'bg-surface text-content-secondary ring-border-base hover:text-content',
                        )}
                      >
                        {t(`workDays.filter.${option}`)}
                        <span
                          className={cn(
                            'rounded-full px-1.5 tabular-nums',
                            filter === option ? 'bg-white/20' : 'bg-surface-sunken',
                          )}
                        >
                          {counts[option]}
                        </span>
                      </button>
                    ),
                  )}
                </div>

                {entriesFailed ? (
                  <p className="px-4 py-6 text-center text-sm text-danger-text">
                    {t('ledgerDays.detailFailed')}
                  </p>
                ) : entries === null ? (
                  <div className="p-4">
                    <LoadingRows rows={4} columns={4} />
                  </div>
                ) : visible.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-content-tertiary">
                    {t('workDays.noMatch')}
                  </p>
                ) : (
                  <ol className="divide-y divide-border-subtle">
                    {visible.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        time={clock(entry.createdAt)}
                        how={kind(entry)}
                      />
                    ))}
                  </ol>
                )}
              </Card>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function StepButton({
  onClick,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex size-9 items-center justify-center rounded-full text-content-secondary ring-1 ring-border-base transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/** One exchange: when, what crossed the counter, how, and where it stands. */
function EntryRow({ entry, time, how }: { entry: DayEntry; time: string; how: How }) {
  const { t, locale } = useLocale();
  const gone = entry.status === 'REVERSED';
  const bank = how !== 'cash';
  const party = locale === 'ar' ? entry.party.ar : (entry.party.en ?? entry.party.ar);

  return (
    <li
      className={cn(
        'grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-surface-sunken/50',
        gone && 'bg-danger-subtle/20',
      )}
    >
      <span className="row-span-2 self-start whitespace-nowrap pt-0.5 text-sm font-semibold tabular-nums text-content-secondary @lg:row-span-1 @lg:self-center">
        {time}
      </span>

      <div className="min-w-0">
        <p
          className={cn(
            'ltr-content flex flex-wrap items-baseline gap-x-2 text-base font-semibold tabular-nums',
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
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-content-tertiary">
          <span className="font-medium text-content-secondary">
            {t(`ledgerDays.how.${how}`)}
            {bank && entry.payoutBankChannel ? ` · ${entry.payoutBankChannel}` : ''}
          </span>
          {how === 'split' && (
            <span className="ltr-content tabular-nums">
              <Money
                value={entry.payoutCashAmount}
                currency={entry.toCurrency}
                decimals={decimalsOf(entry.toCurrency)}
              />{' '}
              +{' '}
              <Money
                value={entry.payoutBankAmount}
                currency={entry.toCurrency}
                decimals={decimalsOf(entry.toCurrency)}
              />
            </span>
          )}
          {party && <span className="truncate">{party}</span>}
          {entry.phone && <span className="tabular-nums ltr-content">{entry.phone}</span>}
          <span className="font-mono ltr-content">{entry.reference}</span>
        </p>
      </div>

      <span className="flex items-center gap-1.5">
        {gone ? (
          <Badge tone="danger">{t('ledgerDays.state.deleted')}</Badge>
        ) : bank ? (
          entry.transferConfirmedAt ? (
            <Badge tone="success">{t('ledgerDays.state.sent')}</Badge>
          ) : (
            <Badge tone="warning">{t('ledgerDays.state.pending')}</Badge>
          )
        ) : (
          <Badge tone="neutral">{t('ledgerDays.how.cash')}</Badge>
        )}
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
}

/**
 * A month, Saturday first as the office's week runs, with the worked days
 * marked: a dot for a day with exchanges, amber when it ended owing the bank.
 */
function MonthCalendar({
  year,
  month,
  onMonth,
  selected,
  todayKey,
  byDate,
  onChoose,
  loading,
}: {
  year: number;
  month: number;
  onMonth: (year: number, month: number) => void;
  selected: string;
  todayKey: string;
  byDate: Map<string, LedgerDay>;
  onChoose: (key: string) => void;
  loading: boolean;
}) {
  const { t, locale } = useLocale();
  const first = new Date(year, month, 1, 12);
  const daysIn = new Date(year, month + 1, 0).getDate();
  // Saturday = 6 in getDay(); how many blanks before the 1st.
  const lead = (first.getDay() + 1) % 7;
  const cells: (number | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysIn }, (_, index) => index + 1),
  ];

  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', { weekday: 'narrow' }).format(
      // 2026-01-03 is a Saturday
      new Date(2026, 0, 3 + index, 12),
    ),
  );

  const shift = (delta: number) => {
    const at = new Date(year, month + delta, 1, 12);
    onMonth(at.getFullYear(), at.getMonth());
  };
  const thisMonth = (() => {
    const now = new Date();
    return year === now.getFullYear() && month === now.getMonth();
  })();

  const BackArrow = locale === 'ar' ? ChevronRight : ChevronLeft;
  const ForwardArrow = locale === 'ar' ? ChevronLeft : ChevronRight;

  // The month's own figures, so a month can be judged before a day is opened.
  let monthOps = 0;
  let monthDays = 0;
  for (const day of byDate.values()) {
    if (day.date.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`) && day.count > 0) {
      monthOps += day.count;
      monthDays += 1;
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => shift(-1)}
          aria-label={t('workDays.prevMonth')}
          className="flex size-8 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-surface-sunken hover:text-content"
        >
          <BackArrow className="size-4" />
        </button>
        <p className="flex items-center gap-2 text-sm font-semibold text-content">
          <CalendarDays className="size-4 text-primary-text" />
          {formatDate(first, locale, { day: undefined, month: 'long', year: 'numeric' })}
        </p>
        <button
          type="button"
          onClick={() => shift(1)}
          disabled={thisMonth}
          aria-label={t('workDays.nextMonth')}
          className="flex size-8 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-surface-sunken hover:text-content disabled:opacity-30"
        >
          <ForwardArrow className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {weekdays.map((label, index) => (
          <span key={index} className="py-1 text-[11px] font-medium text-content-tertiary">
            {label}
          </span>
        ))}
        {cells.map((value, index) => {
          if (value === null) return <span key={`blank-${index}`} />;
          const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(value).padStart(2, '0')}`;
          const day = byDate.get(key);
          const workedDay = !!day && day.count > 0;
          const owes = !!day && day.owedAtEnd.some((entry) => BigInt(entry.amount) !== 0n);
          const future = key > todayKey;
          const isSelected = key === selected;
          return (
            <button
              key={key}
              type="button"
              disabled={future}
              onClick={() => onChoose(key)}
              aria-pressed={isSelected}
              aria-label={key}
              className={cn(
                'relative flex aspect-square flex-col items-center justify-center rounded-xl text-sm tabular-nums transition-colors',
                isSelected
                  ? 'bg-primary font-semibold text-white shadow-[var(--shadow-sm)]'
                  : workedDay
                    ? 'font-semibold text-content hover:bg-primary-subtle'
                    : 'text-content-tertiary hover:bg-surface-sunken',
                key === todayKey && !isSelected && 'ring-1 ring-primary',
                future && 'opacity-30 hover:bg-transparent',
                loading && 'animate-pulse',
              )}
            >
              {value}
              {workedDay && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute bottom-1 size-1 rounded-full',
                    isSelected ? 'bg-white' : owes ? 'bg-warning' : 'bg-primary',
                  )}
                />
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-3 border-t border-border-subtle pt-2.5 text-center text-xs text-content-secondary">
        {monthDays > 0
          ? t('workDays.monthSummary', {
              ops: `${monthOps} ${opsWord(monthOps, locale)}`,
              days: monthDays,
            })
          : t('workDays.monthEmpty')}
      </p>
    </div>
  );
}
