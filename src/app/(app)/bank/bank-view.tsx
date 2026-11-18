'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  CheckCircle2,
  Clock,
  Coins,
  CornerUpRight,
  Globe,
  Inbox,
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
import { keyOf, plainFigure, stateOf, type Desk, type Line, type LineState, type Origin } from './desk-types';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Card, EmptyState, Skeleton } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/** Minutes a transfer may wait before it is flagged, then flagged red. */
export const LATE_AFTER = 15;
export const VERY_LATE_AFTER = 30;

/** How late a waiting transfer is, by the clock: on time, late, or very late. */
export function lateness(line: Line, now: number): 'ok' | 'late' | 'veryLate' {
  const state = stateOf(line);
  if (state !== 'waiting' && state !== 'forwarded') return 'ok';
  const minutes = (now - new Date(line.at).getTime()) / 60_000;
  return minutes >= VERY_LATE_AFTER ? 'veryLate' : minutes >= LATE_AFTER ? 'late' : 'ok';
}

/** One colour per bank, the same every time it is named: the eye finds its bank before the words. */
const BANK_COLORS = [
  'bg-sky-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-teal-500',
  'bg-indigo-500',
  'bg-fuchsia-500',
  'bg-orange-500',
  'bg-cyan-600',
];
export function bankColor(channel: string | null): string {
  if (!channel) return 'bg-slate-400';
  let hash = 0;
  for (const char of channel.replace(/\s+/g, '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return BANK_COLORS[hash % BANK_COLORS.length]!;
}
/** A bank's mark: the first letter of each of its first two words. */
export function bankInitials(channel: string | null): string {
  if (!channel) return '—';
  return channel
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.replace(/^ال(?=..)/, '').charAt(0))
    .join('')
    .toUpperCase();
}

/** The round mark of a bank, or of a bare message. */
export function BankMark({ line, className }: { line: Pick<Line, 'channel' | 'source'>; className?: string }) {
  if (line.source === 'message') {
    return (
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-content-tertiary ring-1 ring-border-subtle',
          className,
        )}
      >
        <MessageSquare className="size-4" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white',
        bankColor(line.channel),
        className,
      )}
      aria-hidden
    >
      {bankInitials(line.channel)}
    </span>
  );
}

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

/** Which lines the list shows. "open" is waiting and forwarded together: what still needs doing. */
type Show = 'open' | 'waiting' | 'forwarded' | 'done' | 'messages' | 'all';
const SHOWN_STATES: Record<Show, LineState[]> = {
  open: ['waiting', 'forwarded'],
  waiting: ['waiting'],
  forwarded: ['forwarded'],
  done: ['done', 'reversed'],
  messages: ['message'],
  all: ['waiting', 'forwarded', 'done', 'reversed', 'message'],
};

/**
 * The bank desk's inbox: every transfer of the bank group, and its other
 * messages, two lines each — who and how much, then where, the account and the
 * time — under three cards that say what waits, what was handed on and what was
 * sent. A transfer that waits too long turns orange, then red. Choosing one
 * opens it in full beside the list.
 */
export function BankView({
  selectedKey,
  onSelect,
  version = 0,
  className,
}: {
  selectedKey: string | null;
  /** A line chosen, or the chosen line as the list now has it. */
  onSelect: (line: Line | null) => void;
  /** Bumped when something changed elsewhere: the list asks again. */
  version?: number;
  className?: string;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [desk, setDesk] = useState<Desk | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [currency, setCurrency] = useState<string | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(false);
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [show, setShow] = useState<Show>('open');
  const [days, setDays] = useState<DayRange>(ANY_DAY);
  const searchBox = useRef<HTMLInputElement>(null);
  /** The clock lateness is read by, moved on every half minute. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

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
   * waits and what was sent today. The group's other messages beside them.
   */
  const everything = useMemo(
    () => [
      ...((desk?.range ?? [...(desk?.waiting ?? []), ...(desk?.sent ?? [])]) as Line[]),
      ...((desk?.others ?? []) as Line[]),
    ],
    [desk],
  );

  // The three cards: how many, how many of those are late, and what they come to.
  const cards = useMemo(() => {
    const tally = (states: LineState[]) => {
      const lines = everything.filter((line) => states.includes(stateOf(line)));
      const sums = new Map<string, bigint>();
      for (const line of lines) {
        if (!line.currency) continue;
        sums.set(line.currency, (sums.get(line.currency) ?? 0n) + BigInt(line.amount));
      }
      return {
        count: lines.length,
        late: lines.filter((line) => lateness(line, now) !== 'ok').length,
        sums: [...sums.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1)),
      };
    };
    return {
      waiting: tally(['waiting']),
      forwarded: tally(['forwarded']),
      done: tally(['done']),
      messages: everything.filter((line) => stateOf(line) === 'message').length,
      all: everything.length,
    };
  }, [everything, now]);

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

  // How many on each bank, so the desk can work one bank at a time.
  const channels = useMemo(() => {
    const totals = new Map<string, number>();
    for (const line of source) totals.set(line.channel ?? '—', (totals.get(line.channel ?? '—') ?? 0) + 1);
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [source]);
  const currencies = [...new Set(source.map((line) => line.currency).filter(Boolean))];
  const kinds = [...new Set(source.map((line) => line.kind))];

  /*
   * Searched by anything the desk might have in hand: the account or the phone
   * (digits only, so "059 211" finds "0592117818"), the name, the deal's number,
   * the words of a message, or the sum as it is read ("1740" finds 1,740.00).
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
  const shown = source
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

  // The list under a heading per day.
  const byDay: { key: string; lines: Line[] }[] = [];
  for (const line of shown) {
    const key = dayKey(line.at);
    let day = byDay.at(-1);
    if (!day || day.key !== key) {
      day = { key, lines: [] };
      byDay.push(day);
    }
    day.lines.push(line);
  }
  const extraFilters = [currency, kind, minAmount || maxAmount].filter(Boolean).length;
  const narrowed = Boolean(needle || currency || kind || channel || minAmount || maxAmount || days.from || days.to);
  const clearAll = () => {
    setQuery('');
    setCurrency(null);
    setKind(null);
    setChannel(null);
    setMinAmount('');
    setMaxAmount('');
    setDays(ANY_DAY);
  };

  if (!desk) {
    return (
      <div className={cn('space-y-3', className)}>
        <Skeleton className="h-24" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  /** One of the three cards: a state, how many, how many are late, and what they come to. */
  const statCard = (
    state: 'waiting' | 'forwarded' | 'done',
    label: string,
    tone: 'warning' | 'primary' | 'success',
    icon: ReactNode,
  ) => {
    const card = cards[state];
    const picked = show === state;
    const lit = picked || (show === 'open' && state !== 'done');
    return (
      <button
        type="button"
        onClick={() => setShow(picked ? 'open' : state)}
        aria-pressed={picked}
        className={cn(
          'relative min-w-0 rounded-xl p-2.5 text-start ring-1 transition-all',
          picked
            ? tone === 'warning'
              ? 'bg-warning-subtle ring-warning/40'
              : tone === 'primary'
                ? 'bg-primary-subtle ring-primary/40'
                : 'bg-success-subtle ring-success/40'
            : lit
              ? 'bg-surface ring-border-subtle hover:ring-border'
              : 'bg-surface-sunken/60 ring-transparent hover:bg-surface hover:ring-border-subtle',
        )}
      >
        <span
          className={cn(
            'flex items-center gap-1 text-[11px] font-semibold',
            tone === 'warning' ? 'text-warning-text' : tone === 'primary' ? 'text-primary-text' : 'text-success-text',
          )}
        >
          {icon}
          <span className="truncate">{label}</span>
          {state !== 'done' && card.late > 0 && (
            <span
              className="ms-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white tabular-nums"
              title={t('bankDesk.lateCount', { count: card.late })}
            >
              {card.late}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xl font-bold leading-tight text-content tabular-nums">{card.count}</span>
        <span className="block truncate text-[10px] font-medium text-content-tertiary">
          {card.sums.length === 0 ? (
            '—'
          ) : (
            <>
              <Money value={card.sums[0]![1]} currency={card.sums[0]![0]} />
              {card.sums.length > 1 && <span> +{card.sums.length - 1}</span>}
            </>
          )}
        </span>
      </button>
    );
  };

  return (
    <Card className={cn('flex flex-col overflow-hidden p-0', className)}>
      {/* --- The head: what waits, one search bar, the banks --- */}
      <div className="space-y-2.5 border-b border-border-subtle p-3">
        <div className="flex items-center gap-2">
          <h2 className="shrink-0 text-[15px] font-bold tracking-tight text-content">{t('bankDesk.inbox')}</h2>
          {desk.group && (
            <span
              title={t('bank.fromBankGroup', { group: desk.group.name })}
              className="inline-flex min-w-0 items-center gap-1 truncate text-[11px] text-content-tertiary"
            >
              <MessagesSquare className="size-3 shrink-0" />
              <span className="truncate">{desk.group.name}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => void load()}
            aria-label={t('bank.refresh')}
            title={t('bank.refresh')}
            className="ms-auto inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-content-tertiary ring-1 ring-border-subtle transition-colors hover:bg-surface-sunken hover:text-content"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>

        {/* The three cards. */}
        <div className="grid grid-cols-3 gap-1.5">
          {statCard('waiting', t('bankDesk.cardWaiting'), 'warning', <Clock className="size-3 shrink-0" />)}
          {statCard('forwarded', t('bankDesk.state.forwarded'), 'primary', <CornerUpRight className="size-3 shrink-0" />)}
          {statCard('done', t('bankDesk.state.done'), 'success', <CheckCircle2 className="size-3 shrink-0" />)}
        </div>

        {/* One bar: the search, the day, the other filters and the order. */}
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
            aria-label={t('bank.filters')}
            className={cn(
              'm-1 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors',
              filtersOpen || extraFilters > 0
                ? 'bg-primary-subtle text-primary-text'
                : 'text-content-secondary hover:bg-surface-sunken hover:text-content',
            )}
          >
            <SlidersHorizontal className="size-3.5" />
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

        {/* The rest, folded: the money, the kind, and a range of sums. */}
        {filtersOpen && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-sunken/70 p-2 ring-1 ring-border-subtle">
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
            <div className="flex h-8 min-w-[12rem] flex-1 items-center gap-1 rounded-full bg-surface px-3 ring-1 ring-border-subtle">
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
        {(currency || kind || minAmount || maxAmount) && !filtersOpen && (
          <div className="flex flex-wrap items-center gap-1.5">
            {currency && <FilterChip icon={<Coins className="size-3" />} label={currency} onClear={() => setCurrency(null)} />}
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

        {/* The banks, each with its colour and count. */}
        <div className="-mx-3 flex items-center gap-1 overflow-x-auto px-3 [scrollbar-width:none]">
          {[
            { key: null as string | null, label: t('bank.all'), count: source.length },
            ...channels.map(([name, count]) => ({ key: name, label: name === '—' ? t('bank.noChannel') : name, count })),
          ].map((chip) => {
            const on = channel === chip.key;
            return (
              <button
                key={chip.key ?? 'all'}
                type="button"
                aria-pressed={on}
                onClick={() => setChannel(on ? null : chip.key)}
                className={cn(
                  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full pe-2.5 text-[11px] font-semibold transition-colors',
                  chip.key === null ? 'ps-2.5' : 'ps-1.5',
                  on ? 'bg-content text-surface' : 'text-content-secondary ring-1 ring-border-subtle hover:bg-surface-sunken',
                )}
              >
                {chip.key !== null && (
                  <span className={cn('size-2.5 rounded-full', bankColor(chip.key === '—' ? null : chip.key))} aria-hidden />
                )}
                {chip.label}
                <span className={cn('tabular-nums', on ? 'opacity-70' : 'text-content-tertiary')}>{chip.count}</span>
              </button>
            );
          })}
        </div>

        {/* The group's other messages, and everything; and a way back from any narrowing. */}
        <div className="flex items-center gap-3 text-[11px] font-semibold">
          {(
            [
              ['messages', t('bankDesk.show.messages'), cards.messages],
              ['all', t('bankDesk.show.all'), cards.all],
            ] as const
          ).map(([entry, label, count]) => (
            <button
              key={entry}
              type="button"
              onClick={() => setShow(show === entry ? 'open' : entry)}
              aria-pressed={show === entry}
              className={cn(
                'inline-flex items-center gap-1 transition-colors',
                show === entry
                  ? 'text-primary-text underline underline-offset-4'
                  : 'text-content-tertiary hover:text-content-secondary',
              )}
            >
              {entry === 'messages' && <MessageSquare className="size-3" />}
              {label}
              <span className="tabular-nums opacity-80">{count}</span>
            </button>
          ))}
          {narrowed && (
            <button
              type="button"
              onClick={clearAll}
              className="ms-auto inline-flex items-center gap-1 text-content-tertiary hover:text-danger-text"
            >
              <X className="size-3" />
              {t('bank.clearFilters')} · <span className="tabular-nums">{shown.length}</span>
            </button>
          )}
        </div>
      </div>

      {/* --- The inbox, two lines a transfer --- */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <EmptyState icon={<Inbox />} title={t('bank.emptyTitle')} description={t('bank.emptyBody')} />
        ) : (
          byDay.map((day) => (
            <section key={day.key}>
              <header className="sticky top-0 z-10 bg-surface/95 px-3 py-1 backdrop-blur">
                <button
                  type="button"
                  onClick={() => setDays({ from: day.key, to: day.key })}
                  title={t('bank.onlyThisDay')}
                  className="text-[11px] font-semibold text-content-tertiary hover:text-primary-text"
                >
                  {dayLabel(day.key, locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') })}
                  <span className="ms-1 font-normal">· {day.lines.length}</span>
                </button>
              </header>
              <ul>
                {day.lines.map((line) => {
                  const key = keyOf(line);
                  const selected = selectedKey === key;
                  const state = stateOf(line);
                  const late = lateness(line, now);
                  const message = line.source === 'message';
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => onSelect(line)}
                        aria-current={selected || undefined}
                        className={cn(
                          'relative flex w-full items-center gap-2.5 px-3 py-2.5 text-start transition-colors',
                          selected ? 'bg-primary-subtle/60' : 'hover:bg-surface-sunken/70',
                          (state === 'done' || state === 'reversed') && !selected && 'opacity-60',
                        )}
                      >
                        {selected && <span className="absolute inset-y-1.5 start-0 w-[3px] rounded-e-full bg-primary" aria-hidden />}
                        <span className="relative shrink-0">
                          <BankMark line={line} />
                          {/* Where it stands: a dot on the mark. */}
                          {!message && (
                            <span
                              className={cn(
                                'absolute -bottom-0.5 -end-0.5 size-3 rounded-full ring-2 ring-surface',
                                state === 'waiting' && 'bg-warning',
                                state === 'forwarded' && 'bg-primary',
                                state === 'done' && 'bg-success',
                                state === 'reversed' && 'bg-danger',
                              )}
                              aria-hidden
                            />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          {/* Who, and how much. */}
                          <span className="flex items-baseline gap-2">
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate text-[13px] text-content',
                                selected || state === 'waiting' ? 'font-bold' : 'font-semibold',
                              )}
                            >
                              {message
                                ? (line.origin?.name ?? line.by ?? t('bankFeed.member'))
                                : (line.name ?? line.account ?? '—')}
                            </span>
                            {BigInt(line.amount || '0') > 0n && (
                              <Money
                                value={line.amount}
                                currency={line.currency}
                                className="shrink-0 text-[13px] font-bold text-content tabular-nums"
                              />
                            )}
                          </span>
                          {/* Where, the account, and when — the time turning orange, then red, as it waits. */}
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-content-tertiary">
                            {message ? (
                              <span className="min-w-0 flex-1 truncate">
                                {line.hasMedia && <Paperclip className="me-0.5 inline size-3" />}
                                {(line.text ?? '').replace(/\s+/g, ' ') || '📎'}
                              </span>
                            ) : (
                              <span className="flex min-w-0 flex-1 items-center gap-1 truncate">
                                {line.origin?.kind === 'external' ? (
                                  <Globe className="size-3 shrink-0 text-warning-text" aria-label={t('bank.originExternal')} />
                                ) : (
                                  <Server className="size-3 shrink-0 text-success-text" aria-label={t('bank.originSystem')} />
                                )}
                                <span className="shrink-0 font-medium text-content-secondary">
                                  {line.channel ?? t('bank.noChannel')}
                                </span>
                                {line.account && (
                                  <span className="truncate font-mono tabular-nums ltr-content">· {line.account}</span>
                                )}
                              </span>
                            )}
                            {state === 'forwarded' && <CornerUpRight className="size-3 shrink-0 text-primary-text" />}
                            <span
                              className={cn(
                                'shrink-0 rounded px-1 font-medium tabular-nums ltr-content',
                                late === 'veryLate'
                                  ? 'bg-danger-subtle font-bold text-danger-text'
                                  : late === 'late'
                                    ? 'bg-warning-subtle font-semibold text-warning-text'
                                    : '',
                              )}
                              title={late !== 'ok' ? t('bankDesk.lateHint') : undefined}
                            >
                              {clockOf(line.at)}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
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
