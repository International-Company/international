'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock,
  Coins,
  Copy,
  CornerUpRight,
  Globe,
  Landmark,
  Layers,
  MessageSquare,
  MessagesSquare,
  Paperclip,
  RefreshCw,
  Search,
  Server,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { clockOf, dayKey, dayLabel } from './days';
import { ANY_DAY, DateRangePicker, inRange, type DayRange } from '@/ui/date-range-picker';
import { PillSelect } from '@/ui/pill-select';
import { STATE_STYLE } from './transfer-detail';
import { MarkSentDialog } from './mark-sent-dialog';
import { keyOf, plainFigure, stateOf, type Desk, type Line, type LineState, type Origin } from './desk-types';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/** Where a transfer came from: a system deal and its teller, or a number outside the office. */
export function OriginBadge({ origin }: { origin?: Origin }) {
  const { t } = useLocale();
  if (!origin) return null;
  const external = origin.kind === 'external';
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
        external ? 'bg-warning-subtle text-warning-text' : 'bg-success-subtle text-success-text',
      )}
      title={external ? t('bank.originExternalHint') : t('bank.originSystemHint')}
    >
      {external ? <Globe className="size-3 shrink-0" /> : <Server className="size-3 shrink-0" />}
      <span className="shrink-0">{external ? t('bank.originExternal') : t('bank.originSystem')}</span>
      {origin.name && <span className="truncate font-medium">· {origin.name}</span>}
      {origin.phone && <span className="shrink-0 font-medium ltr-content">+{origin.phone}</span>}
    </span>
  );
}

/** A filter that is on, shown under the search bar with its own way off. */
function FilterChip({ icon, label, onClear }: { icon?: ReactNode; label: string; onClear: () => void }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-primary-subtle ps-2 pe-0.5 text-[11px] font-semibold text-primary-text">
      {icon}
      <span className="ltr-content tabular-nums">{label}</span>
      <button
        type="button"
        onClick={onClear}
        aria-label={label}
        className="inline-flex size-5 items-center justify-center rounded-full hover:bg-primary/15"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

/** A value with a button that puts it on the clipboard, for pasting into the bank's app. */
function CopyValue({ value, label, big }: { value: string; label: string; big?: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(value);
        toast.success(t('bank.copied'), label);
      }}
      className={cn(
        'group inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-start transition-colors hover:bg-surface-sunken',
        big ? 'text-lg font-semibold' : 'text-sm',
      )}
    >
      <span className="ltr-content break-all tabular-nums">{value}</span>
      <Copy className="size-3.5 shrink-0 text-content-tertiary group-hover:text-primary-text" />
    </button>
  );
}

/** Which lines the list shows: those still open, handed on, sent, the group's other messages, or all. */
type Show = 'open' | 'forwarded' | 'done' | 'messages' | 'all';
const SHOWS: Show[] = ['open', 'forwarded', 'done', 'messages', 'all'];
const SHOWN_STATES: Record<Show, LineState[]> = {
  open: ['waiting', 'forwarded'],
  forwarded: ['forwarded'],
  done: ['done', 'reversed'],
  messages: ['message'],
  all: ['waiting', 'forwarded', 'done', 'reversed', 'message'],
};

/**
 * The first column of the bank desk: every transfer of the bank group, and its
 * other messages, oldest first, laid out the way the bank's app asks for it —
 * where, the account, the name, the sum, each copied with a tap. Choosing one
 * opens it in full beside the list; sending one is a tap away here too.
 */
export function BankView({
  selectedKey,
  onSelect,
  version = 0,
  onChanged,
  className,
}: {
  selectedKey: string | null;
  /** A line chosen, or the chosen line as the list now has it. */
  onSelect: (line: Line | null) => void;
  /** Bumped by the other columns when something changed: the list asks again. */
  version?: number;
  onChanged?: () => void;
  className?: string;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [desk, setDesk] = useState<Desk | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  /** Narrowing the list: words, the money it is in, the kind of deal, and which end first. */
  const [query, setQuery] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(false);
  /** A range of sums, in the transfer's own money: either end may be left open. */
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  /** The money, the kind and the sums: folded away until asked for. */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sending, setSending] = useState<Line | null>(null);
  /** Open by default: what still needs doing. */
  const [show, setShow] = useState<Show>('open');

  const searchBox = useRef<HTMLInputElement>(null);

  /** Which days, chosen on the calendar. */
  const [days, setDays] = useState<DayRange>(ANY_DAY);

  const load = useCallback(async () => {
    try {
      // A day's bounds in the browser's clock, the day the teller lived through.
      const edge = (key: string, end: boolean) => {
        const [year, month, day] = key.split('-').map(Number) as [number, number, number];
        return (end ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day)).toISOString();
      };
      const asked =
        days.from || days.to
          ? `?${new URLSearchParams({
              ...(days.from ? { from: edge(days.from, false) } : {}),
              ...(days.to ? { to: edge(days.to, true) } : {}),
            }).toString()}`
          : '';
      setDesk(await api.get<Desk>(`/api/bank${asked}`));
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      );
      setDesk((current) => current ?? { waiting: [], sent: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, t, days, version]);

  useEffect(() => {
    void load();
    // New deals keep arriving at the counter; a desk nobody is looking at asks nothing.
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  /*
   * The days chosen bring every transfer in them, sent or not; otherwise what
   * waits and what was sent today. The group's other messages beside them; then
   * only those of the state asked for.
   */
  const everything = useMemo(
    () => [...((desk?.range ?? [...(desk?.waiting ?? []), ...(desk?.sent ?? [])]) as Line[]), ...((desk?.others ?? []) as Line[])],
    [desk],
  );
  const counts = useMemo(() => {
    const by = Object.fromEntries(SHOWS.map((entry) => [entry, 0])) as Record<Show, number>;
    for (const line of everything) {
      const state = stateOf(line);
      for (const entry of SHOWS) if (SHOWN_STATES[entry].includes(state)) by[entry] += 1;
    }
    return by;
  }, [everything]);
  const source = useMemo(
    () => everything.filter((line) => SHOWN_STATES[show].includes(stateOf(line))),
    [everything, show],
  );

  // The chosen line, as the list now has it: handed on or sent since, the details follow.
  useEffect(() => {
    if (!selectedKey || !desk) return;
    const fresh = everything.find((line) => keyOf(line) === selectedKey);
    if (fresh) onSelect(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desk]);

  // What is waiting on each account, so the desk can work one bank at a time.
  const channels = useMemo(() => {
    const totals = new Map<string, { count: number; sums: Map<string, bigint> }>();
    for (const line of source) {
      const key = line.channel ?? '—';
      const entry = totals.get(key) ?? { count: 0, sums: new Map() };
      entry.count += 1;
      entry.sums.set(line.currency, (entry.sums.get(line.currency) ?? 0n) + BigInt(line.amount));
      totals.set(key, entry);
    }
    return [...totals.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [source]);

  // What the list can be narrowed by: the money and the kinds actually waiting.
  const currencies = [...new Set(source.map((line) => line.currency).filter(Boolean))];
  const kinds = [...new Set((source).map((line) => line.kind))];
  /*
   * Searched by anything the desk might have in hand: the account or the phone
   * (digits only, so "059 211" finds "0592117818"), the name, the deal's number,
   * or the sum as it is read ("1740" finds 1,740.00).
   */
  const needle = query.trim().toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const matches = (line: Line) => {
    if (!needle) return true;
    const words = [line.name, line.reference, line.channel, line.notes, line.kind, line.text, line.by]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (words.includes(needle)) return true;
    if (!digits) return false;
    return [line.account, line.phone, plainFigure(line.amount)].some((value) =>
      (value ?? '').replace(/\D/g, '').includes(digits),
    );
  };
  const shown = (source)
    .filter((line) => !channel || (line.channel ?? '—') === channel)
    .filter((line) => !currency || line.currency === currency)
    .filter((line) => !kind || line.kind === kind)
    .filter((line) => {
      const sum = Number(line.amount) / 1e8;
      const low = Number(digitsOnly(minAmount));
      const high = Number(digitsOnly(maxAmount));
      return (!minAmount || sum >= low) && (!maxAmount || sum <= high);
    })
    .filter((line) => inRange(dayKey(line.at), days))
    .filter(matches);
  if (newestFirst) shown.reverse();

  // The list under a heading per day, each with its count and what it comes to.
  const byDay: { key: string; lines: Line[]; sums: Map<string, bigint> }[] = [];
  for (const line of shown) {
    const key = dayKey(line.at);
    let day = byDay.at(-1);
    if (!day || day.key !== key) {
      day = { key, lines: [], sums: new Map() };
      byDay.push(day);
    }
    day.lines.push(line);
    if (line.source !== 'message' && line.currency) {
      day.sums.set(line.currency, (day.sums.get(line.currency) ?? 0n) + BigInt(line.amount));
    }
  }
  // What the shown transfers come to, in each money: the biggest first.
  const totals = (() => {
    const sums = new Map<string, bigint>();
    for (const line of shown) {
      if (line.source === 'message' || !line.currency) continue;
      sums.set(line.currency, (sums.get(line.currency) ?? 0n) + BigInt(line.amount));
    }
    return [...sums.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1));
  })();
  // How many of the folded filters are on, shown on the button that unfolds them.
  const extraFilters = [currency, kind, minAmount || maxAmount].filter(Boolean).length;
  const narrowed = Boolean(
    needle || currency || kind || channel || minAmount || maxAmount || days.from || days.to,
  );

  if (!desk) {
    return (
      <div className={cn('space-y-3', className)}>
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <Card className={cn('flex flex-col overflow-hidden p-0', className)}>
      {/* --- The list's head: what it holds, one search bar, and the banks as tabs --- */}
      <div className="border-b border-border-subtle">
        <div className="space-y-2.5 px-3 pt-3">
          {/* What the list holds: how many, and what they come to in each money. */}
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-bold tracking-tight text-content">
                  {desk.range ? t('bank.ofTheDays') : t('bank.waiting')}
                </h2>
                <span className="inline-flex h-5 items-center rounded-md bg-primary px-1.5 text-[11px] font-bold tabular-nums text-white">
                  {narrowed ? `${shown.length} / ${source.length}` : source.length}
                </span>
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-content-tertiary">
                {desk.group && (
                  <span
                    title={t('bank.fromBankGroup', { group: desk.group.name })}
                    className="inline-flex min-w-0 items-center gap-1"
                  >
                    <MessagesSquare className="size-3 shrink-0" />
                    <span className="truncate">{desk.group.name}</span>
                  </span>
                )}
                {totals.length > 0 && (
                  <span className="inline-flex flex-wrap items-center gap-x-1.5 font-medium text-content-secondary">
                    {totals.map(([code, sum], index) => (
                      <span key={code} className="inline-flex items-center gap-1.5">
                        {index > 0 && <span className="text-content-tertiary">·</span>}
                        <Money value={sum} currency={code} className="tabular-nums" />
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              aria-label={t('bank.refresh')}
              title={t('bank.refresh')}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-content-tertiary ring-1 ring-border-subtle transition-colors hover:bg-surface-sunken hover:text-content"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>

          {/* One bar: the search, then the day, the other filters and the order, set apart by thin lines. */}
          <div className="flex h-10 items-stretch rounded-xl bg-surface shadow-[var(--shadow-sm)] ring-1 ring-border-subtle transition-shadow focus-within:ring-2 focus-within:ring-primary/50">
            <label className="relative flex min-w-0 flex-1 items-center">
              <Search className="pointer-events-none absolute start-3 size-4 text-content-tertiary" />
              <input
                ref={searchBox}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setQuery('');
                    event.currentTarget.blur();
                  }
                }}
                placeholder={t('bank.searchShort')}
                title={t('bank.search')}
                aria-label={t('bank.search')}
                className="h-full w-full min-w-0 bg-transparent ps-9 pe-2 text-[13px] text-content outline-none placeholder:text-content-tertiary [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={t('bank.clearFilters')}
                  className="me-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </label>
            <span className="my-2 w-px shrink-0 bg-border-subtle" aria-hidden />
            <div className="flex shrink-0 items-center px-1">
              <DateRangePicker value={days} onChange={setDays} bare className="h-8" />
            </div>
            <span className="my-2 w-px shrink-0 bg-border-subtle" aria-hidden />
            <button
              type="button"
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              title={t('bank.filters')}
              className={cn(
                'm-1 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold transition-colors',
                filtersOpen || extraFilters > 0
                  ? 'bg-primary-subtle text-primary-text'
                  : 'text-content-secondary hover:bg-surface-sunken hover:text-content',
              )}
            >
              <SlidersHorizontal className="size-3.5" />
              <span className="hidden sm:inline">{t('bank.filters')}</span>
              {extraFilters > 0 && (
                <span className="inline-flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-white tabular-nums">
                  {extraFilters}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setNewestFirst((value) => !value)}
              title={newestFirst ? t('bank.newestFirst') : t('bank.oldestFirst')}
              aria-label={newestFirst ? t('bank.newestFirst') : t('bank.oldestFirst')}
              className="my-1 me-1 inline-flex w-8 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-sunken hover:text-content"
            >
              {newestFirst ? <ArrowUpWideNarrow className="size-4" /> : <ArrowDownWideNarrow className="size-4" />}
            </button>
          </div>

          {/* Where they stand: open by default, then handed on, sent, the group's other messages, or all. */}
          <div className="flex gap-0.5 overflow-x-auto rounded-xl bg-surface-sunken p-0.5 [scrollbar-width:none]" role="tablist">
            {SHOWS.map((entry) => (
              <button
                key={entry}
                type="button"
                role="tab"
                aria-selected={show === entry}
                onClick={() => setShow(entry)}
                className={cn(
                  'inline-flex h-7 flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-[10px] px-2 text-[11px] font-semibold transition-all',
                  show === entry
                    ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                    : 'text-content-tertiary hover:text-content-secondary',
                )}
              >
                {t(`bankDesk.show.${entry}`)}
                <span
                  className={cn(
                    'tabular-nums',
                    show === entry
                      ? entry === 'forwarded'
                        ? 'text-primary-text'
                        : entry === 'open'
                          ? 'text-warning-text'
                          : 'text-content-secondary'
                      : 'opacity-70',
                  )}
                >
                  {counts[entry]}
                </span>
              </button>
            ))}
          </div>

          {/* The rest, folded: the money, the kind, and a range of sums. */}
          {filtersOpen && (
            <div className="grid grid-cols-1 gap-2 rounded-xl bg-surface-sunken/70 p-2 ring-1 ring-border-subtle sm:grid-cols-[auto_auto_1fr]">
              {currencies.length > 1 && (
                <PillSelect
                  label={t('bank.currency')}
                  placeholder={t('bank.anyCurrency')}
                  icon={<Coins className="size-3.5 shrink-0" />}
                  value={currency}
                  onChange={setCurrency}
                  options={currencies.map((code) => ({
                    value: code,
                    label: code,
                    hint: source.filter((line) => line.currency === code).length,
                  }))}
                />
              )}
              {kinds.length > 1 && (
                <PillSelect
                  label={t('bank.kind')}
                  placeholder={t('bank.anyKind')}
                  icon={<Layers className="size-3.5 shrink-0" />}
                  value={kind}
                  onChange={setKind}
                  options={kinds.map((name) => ({
                    value: name,
                    label: name,
                    hint: source.filter((line) => line.kind === name).length,
                  }))}
                />
              )}
              <div className="flex h-8 items-center gap-1 rounded-full bg-surface px-3 ring-1 ring-border-subtle">
                <span className="shrink-0 text-[11px] font-medium text-content-tertiary">{t('bank.amountRange')}</span>
                <input
                  inputMode="decimal"
                  dir="ltr"
                  value={minAmount}
                  onChange={(event) => setMinAmount(digitsOnly(event.target.value))}
                  placeholder={t('bank.from')}
                  aria-label={t('bank.from')}
                  className="h-full min-w-0 flex-1 bg-transparent text-center text-xs font-semibold tabular-nums text-content outline-none"
                />
                <span className="text-xs text-content-tertiary">–</span>
                <input
                  inputMode="decimal"
                  dir="ltr"
                  value={maxAmount}
                  onChange={(event) => setMaxAmount(digitsOnly(event.target.value))}
                  placeholder={t('bank.to')}
                  aria-label={t('bank.to')}
                  className="h-full min-w-0 flex-1 bg-transparent text-center text-xs font-semibold tabular-nums text-content outline-none"
                />
              </div>
            </div>
          )}

          {/* What is on, each taken off by itself. */}
          {(currency || kind || minAmount || maxAmount) && !filtersOpen && (
            <div className="flex flex-wrap items-center gap-1.5">
              {currency && (
                <FilterChip icon={<Coins className="size-3" />} label={currency} onClear={() => setCurrency(null)} />
              )}
              {kind && <FilterChip icon={<Layers className="size-3" />} label={kind} onClear={() => setKind(null)} />}
              {(minAmount || maxAmount) && (
                <FilterChip
                  label={`${minAmount || '0'} – ${maxAmount || '∞'}`}
                  onClear={() => {
                    setMinAmount('');
                    setMaxAmount('');
                  }}
                />
              )}
            </div>
          )}
        </div>

        {/* The banks as tabs, each with how many wait on it. */}
        <div className="mt-2 flex items-end gap-0.5 overflow-x-auto px-2 [scrollbar-width:none]">
          {[
            { key: null as string | null, label: t('bank.all'), count: source.length },
            ...channels.map(([name, entry]) => ({
              key: name,
              label: name === '—' ? t('bank.noChannel') : name,
              count: entry.count,
            })),
          ].map((chip) => {
            const on = channel === chip.key;
            return (
              <button
                key={chip.key ?? 'all'}
                type="button"
                aria-pressed={on}
                onClick={() => setChannel(on ? null : chip.key)}
                className={cn(
                  'relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-t-lg px-2.5 text-xs font-semibold transition-colors',
                  on ? 'text-content' : 'text-content-tertiary hover:bg-surface-sunken/70 hover:text-content-secondary',
                )}
              >
                {chip.label}
                <span
                  className={cn(
                    'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums',
                    on ? 'bg-primary text-white' : 'bg-surface-sunken text-content-tertiary',
                  )}
                >
                  {chip.count}
                </span>
                {on && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" aria-hidden />}
              </button>
            );
          })}
          {narrowed && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setCurrency(null);
                setKind(null);
                setChannel(null);
                setMinAmount('');
                setMaxAmount('');
                setDays(ANY_DAY);
              }}
              className="sticky end-0 ms-auto inline-flex h-9 shrink-0 items-center gap-1 bg-surface ps-2 pe-1 text-[11px] font-semibold text-content-tertiary hover:text-danger-text"
            >
              <X className="size-3" />
              {t('bank.clearFilters')}
            </button>
          )}
        </div>
      </div>

      {/* --- What is still to be sent, oldest first, one compact row each --- */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <EmptyState icon={<CheckCircle2 />} title={t('bank.emptyTitle')} description={t('bank.emptyBody')} />
        ) : (
          byDay.map((day) => (
          <section key={day.key}>
            {/* The day's heading stays in sight while its transfers scroll under it. */}
            <header className="sticky top-0 z-10 flex items-center justify-between gap-2 border-y border-border-subtle bg-surface/95 px-3 py-1.5 backdrop-blur">
              <button
                type="button"
                onClick={() => setDays({ from: day.key, to: day.key })}
                title={t('bank.onlyThisDay')}
                className="rounded-md text-xs font-semibold text-content hover:text-primary-text"
              >
                {dayLabel(day.key, locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') })}
                <span className="ms-1.5 font-normal text-content-tertiary">· {day.lines.length}</span>
              </button>
              <span className="flex flex-wrap justify-end gap-x-2 text-[11px] text-content-secondary">
                {[...day.sums.entries()].map(([code, sum]) => (
                  <Money key={code} value={sum} currency={code} />
                ))}
              </span>
            </header>
          <ul className="divide-y divide-border-subtle">
            {day.lines.map((line) => (
              <li
                key={keyOf(line)}
                onClick={() => onSelect(line)}
                aria-selected={selectedKey === keyOf(line)}
                className={cn(
                  'relative cursor-pointer space-y-1.5 px-3 py-2.5 transition-colors hover:bg-surface-sunken',
                  selectedKey === keyOf(line) &&
                    'bg-primary-subtle/50 before:absolute before:inset-y-0 before:start-0 before:w-[3px] before:bg-primary hover:bg-primary-subtle/60',
                )}
              >
                {/* Where and from whom, then the sum and its button: on a narrow screen the sum drops under them. */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <div className="flex min-w-0 flex-1 basis-[11rem] flex-wrap items-center gap-1">
                    {line.source === 'message' ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-semibold text-content-secondary">
                        <MessageSquare className="size-3 shrink-0" />
                        {t('bankDesk.messageItem')}
                      </span>
                    ) : (
                      <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] font-semibold text-primary-text">
                        <Landmark className="size-3 shrink-0" />
                        <span className="truncate">{line.channel ?? t('bank.noChannel')}</span>
                      </span>
                    )}
                    <OriginBadge origin={line.origin} />
                  </div>
                  <div className="ms-auto flex shrink-0 items-center gap-2">
                  {line.source !== 'message' && (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void navigator.clipboard?.writeText(plainFigure(line.amount));
                      toast.success(t('bank.copied'), t('bank.amount'));
                    }}
                    title={t('bank.amount')}
                  >
                    <Money value={line.amount} currency={line.currency} className="text-base font-bold text-content" />
                  </button>
                  )}
                  {line.status === 'PENDING_TRANSFER' ? (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Check />}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSending(line);
                      }}
                    >
                      {t('bank.markSentShort')}
                    </Button>
                  ) : line.source !== 'message' ? (
                    <span
                      className={cn(
                        'inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-semibold',
                        STATE_STYLE[stateOf(line)].chip,
                      )}
                    >
                      {stateOf(line) === 'done' && <CheckCircle2 className="size-3.5" />}
                      {t(STATE_STYLE[stateOf(line)].key)}
                    </span>
                  ) : null}
                  </div>
                </div>
                {line.source === 'message' && (
                  <p className="line-clamp-2 whitespace-pre-line break-words rounded-lg bg-surface-sunken px-2.5 py-1.5 text-xs text-content-secondary">
                    {line.hasMedia && <Paperclip className="me-1 inline size-3" />}
                    {line.text || '📎'}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-1">
                  {line.account && <CopyValue value={line.account} label={t('bank.account')} big />}
                  {line.name && <CopyValue value={line.name} label={t('bank.name')} />}
                  {line.phone && line.phone !== line.account && (
                    <CopyValue value={line.phone} label={t('bank.phone')} />
                  )}
                </div>
                <p className="flex items-center gap-1 truncate text-[11px] text-content-tertiary">
                  <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-surface-sunken px-1 font-medium tabular-nums text-content-secondary ltr-content">
                    <Clock className="size-3" />
                    {clockOf(line.at)}
                  </span>
                  {stateOf(line) === 'forwarded' && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary-subtle px-1 font-semibold text-primary-text">
                      <CornerUpRight className="size-3" />
                      {t('bankDesk.state.forwarded')}
                    </span>
                  )}
                  <span className="truncate">
                    {line.source === 'message' ? (
                      line.readable ? t('bankDesk.addRead') : line.reference
                    ) : (
                      <>
                        {line.kind} · <span className="ltr-content font-mono">{line.reference}</span>
                        {line.by && line.source !== 'group' && line.by !== line.origin?.name && <> · {line.by}</>}
                        {line.notes && <> · {line.notes}</>}
                      </>
                    )}
                  </span>
                </p>
              </li>
            ))}
          </ul>
          </section>
          ))
        )}

      </div>

      <MarkSentDialog
        line={sending}
        onClose={() => setSending(null)}
        onDone={() => {
          void load();
          onChanged?.();
        }}
      />
    </Card>
  );
}

/** A typed sum as digits and one point: Arabic digits read as Western, commas dropped. */
function digitsOnly(raw: string): string {
  return raw
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[,٬]/g, '')
    .replace(/٫/g, '.')
    .replace(/[^\d.]/g, '')
    .replace(/(\..*)\./g, '$1');
}
