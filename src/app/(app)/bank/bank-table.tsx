'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CheckCircle2,
  CheckSquare,
  Copy,
  CornerUpRight,
  PictureInPicture2,
  Inbox,
  RefreshCw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Money } from '@/ui/display';
import { PartsBar, remainingOf } from './parts';
import { DateRangePicker, inRange, keyOf as dayOf, type DayRange } from '@/ui/date-range-picker';
import { cn } from '@/ui/utils';
import { BankMark, lateness } from './bank-view';
import { clockOf, dayKey, dayLabel } from './days';
import { keyOf, plainFigure, stateOf, type Desk, type Line, type LineState } from './desk-types';
import { STATE_STYLE } from './transfer-detail';
import type { Group } from './forward-panel';

/**
 * The bank desk as an operations table: every transfer of the day in a row of
 * its own — when, which bank, the account, the name and the sum, each copied
 * with a tap where it stands — its state and how long it has waited, and the
 * two things done to it, passed on or sent, at the end of the row. Several are
 * ticked and sent together. A row opened shows the transfer in full beside the
 * table. Today's, unless other days are asked for; a search looks in every day.
 */

/** Where a transfer stands, as one small dot. */
const STATE_DOT: Record<LineState, string> = {
  waiting: 'bg-warning',
  forwarded: 'bg-primary',
  done: 'bg-success',
  reversed: 'bg-danger',
  message: 'bg-content-tertiary',
};

type Show = 'all' | 'open' | 'waiting' | 'forwarded' | 'done' | 'messages' | 'unsorted' | 'partial' | 'short';

/**
 * A message of the bank group that looks like a transfer — it carries an
 * account or a phone, a run of six digits or more — but the bot could not put
 * in the list: written in a shape it does not read. Talk ("تم ✅") is not one.
 */
const unsorted = (line: Line) =>
  stateOf(line) === 'message' && /\d{6,}/.test((line.text ?? '').replace(/[\s\-.]/g, ''));

const SHOWN: Record<Show, LineState[]> = {
  all: ['waiting', 'forwarded', 'done', 'reversed'],
  open: ['waiting', 'forwarded'],
  waiting: ['waiting'],
  forwarded: ['forwarded'],
  done: ['done', 'reversed'],
  messages: ['message'],
  unsorted: ['message'],
  partial: ['waiting', 'forwarded'],
  short: ['done'],
};

const today = (): DayRange => {
  const key = dayOf(new Date());
  return { from: key, to: key };
};

const minutesSince = (at: string, now: number) => Math.max(0, Math.round((now - new Date(at).getTime()) / 60_000));

export function BankTable({
  selectedKey,
  onOpen,
  onSend,
  onFloat,
  onFresh,
  onForward,
  executors,
  version,
  onChanged,
}: {
  selectedKey: string | null;
  /** Opens a transfer in full, beside the table. */
  onOpen: (line: Line) => void;
  /** Opens the "sent" confirmation for one transfer, with its receipt. */
  onSend: (line: Line) => void;
  /** Opens the transfer's floating window, above the bank's site. */
  onFloat?: (line: Line) => void;
  /** The open transfer as the list read it again: what is left of it, where it stands. */
  onFresh?: (line: Line) => void;
  /** Opens the forward sheet for one transfer, with these groups ticked. */
  onForward: (line: Line, preset?: Group[]) => void;
  executors: Group[];
  version: number;
  onChanged: () => void;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [desk, setDesk] = useState<Desk | null>(null);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState<DayRange>(today);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [channel, setChannel] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // A search a moment after the typing stops: every day, whatever day is chosen.
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim().length >= 2 ? query.trim() : ''), 400);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const edge = (key: string, end: boolean) => {
        const [year, month, day] = key.split('-').map(Number) as [number, number, number];
        return (end ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day)).toISOString();
      };
      const asked = searched
        ? `?${new URLSearchParams({ q: searched }).toString()}`
        : days.from || days.to
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
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, searched, version]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const onToday = days.from === today().from && days.to === today().to;
  /** Still waiting from an earlier day, on today's list: it moves on with the days until it is sent. */
  const carried = useCallback(
    (line: Line) => onToday && !searched && dayKey(line.at) < (today().from ?? ''),
    [onToday, searched],
  );

  const everything = useMemo(() => {
    const listed = [
      ...((desk?.range ?? [...(desk?.waiting ?? []), ...(desk?.sent ?? [])]) as Line[]),
      ...((desk?.others ?? []) as Line[]),
    ].filter((line) => Boolean(searched) || inRange(dayKey(line.at), days));
    if (!onToday || searched) return listed;
    // Yesterday's unsent, and older: kept with the day they were recorded, waiting at the top of today.
    const seen = new Set(listed.map(keyOf));
    const older = ((desk?.waiting ?? []) as Line[]).filter((line) => carried(line) && !seen.has(keyOf(line)));
    return [...older, ...listed];
  }, [desk, days, searched, onToday, carried]);
  // The open transfer handed back as it is now, each time the list is read again.
  useEffect(() => {
    if (!selectedKey || !onFresh) return;
    const fresh = everything.find((line) => keyOf(line) === selectedKey);
    if (fresh) onFresh(fresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [everything, selectedKey]);
  const olderWaiting = everything.filter((line) => carried(line) && line.status === 'PENDING_TRANSFER' && !line.sentAt).length;

  // The figures across the top: how many, how many late, and what they come to.
  const figures = useMemo(() => {
    const of = (states: LineState[]) => {
      const lines = everything.filter((line) => states.includes(stateOf(line)));
      const sums = new Map<string, bigint>();
      for (const line of lines) {
        if (line.currency) sums.set(line.currency, (sums.get(line.currency) ?? 0n) + BigInt(line.amount || '0'));
      }
      const top = [...sums.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1))[0];
      return {
        count: lines.length,
        late: lines.filter((line) => lateness(line, now) !== 'ok').length,
        sum: top ? { currency: top[0], amount: top[1].toString() } : null,
      };
    };
    return {
      waiting: of(['waiting']),
      forwarded: of(['forwarded']),
      done: of(['done']),
      all: of(['waiting', 'forwarded', 'done']),
      messages: everything.filter((line) => stateOf(line) === 'message').length,
      // Sent in part and still open: how many, and what is left of them, in the money most of it is in.
      partial: (() => {
        const open = everything.filter((line) => line.paid && ['waiting', 'forwarded'].includes(stateOf(line)));
        const left = new Map<string, bigint>();
        for (const line of open) left.set(line.currency, (left.get(line.currency) ?? 0n) + remainingOf(line.amount, line.paid));
        const top = [...left.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1))[0];
        return { count: open.length, left: top ? { currency: top[0], amount: top[1].toString() } : null };
      })(),
      // Marked sent, but its receipts come to less than its sum.
      short: (() => {
        const lines = everything.filter(
          (line) => line.paid && stateOf(line) === 'done' && remainingOf(line.amount, line.paid) > 0n,
        );
        const left = new Map<string, bigint>();
        for (const line of lines) left.set(line.currency, (left.get(line.currency) ?? 0n) + remainingOf(line.amount, line.paid));
        const top = [...left.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1))[0];
        return { count: lines.length, left: top ? { currency: top[0], amount: top[1].toString() } : null };
      })(),
      unsorted: everything.filter(unsorted).length,
    };
  }, [everything, now]);

  const banks = useMemo(() => {
    const totals = new Map<string, number>();
    for (const line of everything) {
      if (stateOf(line) === 'message') continue;
      totals.set(line.channel ?? '—', (totals.get(line.channel ?? '—') ?? 0) + 1);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [everything]);

  const needle = query.trim().toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const rows = everything
    .filter((line) => SHOWN[show].includes(stateOf(line)) && (show !== 'partial' || Boolean(line.paid)) && (show !== 'short' || remainingOf(line.amount, line.paid) > 0n && Boolean(line.paid)))
    .filter((line) => show !== 'unsorted' || unsorted(line))
    .filter((line) => !channel || (line.channel ?? '—') === channel)
    .filter((line) => {
      if (!needle) return true;
      const words = [line.name, line.reference, line.channel, line.kind, line.text, line.by].filter(Boolean).join(' ').toLowerCase();
      if (words.includes(needle)) return true;
      return Boolean(digits) && [line.account, line.phone, plainFigure(line.amount)].some((value) => (value ?? '').replace(/\D/g, '').includes(digits));
    })
    // What waits first, the longest waiting at the top; then what was sent, newest first.
    .sort((a, b) => {
      const openA = stateOf(a) === 'waiting' || stateOf(a) === 'forwarded';
      const openB = stateOf(b) === 'waiting' || stateOf(b) === 'forwarded';
      if (openA !== openB) return openA ? -1 : 1;
      return openA
        ? new Date(a.at).getTime() - new Date(b.at).getTime()
        : new Date(b.sentAt ?? b.at).getTime() - new Date(a.sentAt ?? a.at).getTime();
    });


  // Ticked: only those still waiting can be sent together.
  const pendingOf = (line: Line) => line.status === 'PENDING_TRANSFER' && !line.sentAt && line.source !== 'message';
  const ticked = rows.filter((line) => checked.has(keyOf(line)));
  const tickable = rows.filter(pendingOf);
  const allTicked = tickable.length > 0 && tickable.every((line) => checked.has(keyOf(line)));
  const toggle = (line: Line) =>
    setChecked((current) => {
      const next = new Set(current);
      const key = keyOf(line);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const copy = (value: string, what: string) => {
    void navigator.clipboard?.writeText(value);
    toast.success(t('bank.copied'), what);
  };

  const copyTicked = () => {
    const text = ticked
      .map((line) => [line.account, line.name, plainFigure(line.amount), line.channel].filter(Boolean).join('\n'))
      .join('\n\n');
    copy(text, t('bankTable.copiedMany', { count: ticked.length }));
  };

  /** Sent, all of them: as the desk's button, without a receipt each. */
  const sendTicked = async () => {
    setSending(true);
    let done = 0;
    for (const line of ticked.filter(pendingOf)) {
      const url =
        line.source === 'group'
          ? `/api/bank/requests/${line.id}`
          : line.source === 'tiktok'
            ? `/api/bank/tiktok/${line.id}`
            : `/api/bank/${line.id}`;
      try {
        await api.post(url, { receipt: null });
        done += 1;
      } catch {
        // One refused does not stop the rest; it stays ticked, so it can be seen.
      }
    }
    setSending(false);
    setConfirming(false);
    setChecked(new Set());
    toast.success(t('bankTable.sentMany', { count: done }));
    onChanged();
    void load();
  };

  /** A wait as the counter says it: "7 د", "1 س 20 د", "2 ي 3 س". */
  const waitedFor = (minutes: number) =>
    minutes < 60
      ? t('bankTrack.minutes', { n: minutes })
      : minutes < 24 * 60
        ? t('bankTrack.hours', { h: Math.floor(minutes / 60), m: minutes % 60 })
        : t('bankTrack.days', { d: Math.floor(minutes / 1440), h: Math.floor((minutes % 1440) / 60) });

  const waitedChip = (line: Line) => {
    const state = stateOf(line);
    if (state === 'done' || state === 'reversed') {
      return line.sentAt ? (
        <span className="whitespace-nowrap text-[11px] tabular-nums text-content-tertiary">✓ {clockOf(line.sentAt)}</span>
      ) : null;
    }
    if (state === 'message') return null;
    const late = lateness(line, now);
    return (
      <span
        className={cn(
          'whitespace-nowrap text-[12px] tabular-nums',
          late === 'veryLate'
            ? 'font-semibold text-danger-text'
            : late === 'late'
              ? 'font-semibold text-warning-text'
              : 'text-content-tertiary',
        )}
      >
        {waitedFor(minutesSince(line.at, now))}
      </span>
    );
  };

  const CopyCell = ({ value, label, children, className }: { value: string | null; label: string; children: ReactNode; className?: string }) =>
    value ? (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          copy(value, label);
        }}
        title={`${t('bankTable.copy')} ${label}`}
        className={cn(
          'group/copy inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-start transition-colors hover:bg-primary-subtle/60',
          className,
        )}
      >
        <span className="min-w-0 truncate">{children}</span>
        <Copy className="size-3 shrink-0 text-primary-text opacity-0 transition-opacity group-hover/copy:opacity-70" />
      </button>
    ) : (
      <span className="px-1.5 text-content-tertiary">—</span>
    );

  const Actions = ({ line }: { line: Line }) => {
    const state = stateOf(line);
    if (state === 'message') {
      return (
        <span className="flex items-center justify-end">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(line);
            }}
            className="inline-flex h-8 items-center rounded-lg bg-warning-subtle px-3 text-xs font-semibold text-warning-text transition-colors hover:bg-warning hover:text-white"
          >
            {t('bankFeed.addToList')}
          </button>
        </span>
      );
    }
    if (state !== 'waiting' && state !== 'forwarded') return null;
    return (
      <span className="flex items-center justify-end gap-1">
        {line.messageId && executors[0] && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onForward(line, [executors[0]!]);
            }}
            title={t('bankTable.forwardTo', { group: executors[0].name })}
            className="inline-flex size-8 items-center justify-center rounded-lg text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-primary-text"
          >
            <CornerUpRight className="size-4" />
          </button>
        )}
        {line.messageId && !executors[0] && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onForward(line);
            }}
            title={t('bankDesk.forwardTab')}
            className="inline-flex size-8 items-center justify-center rounded-lg text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-primary-text"
          >
            <CornerUpRight className="size-4" />
          </button>
        )}
        {onFloat && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onFloat(line);
            }}
            title={t('bankSent.floatRow')}
            aria-label={t('bankSent.floatRow')}
            className="inline-flex size-8 items-center justify-center rounded-lg text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-primary-text"
          >
            <PictureInPicture2 className="size-4" />
          </button>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSend(line);
          }}
          title={t('bank.markSent')}
          className="inline-flex h-8 items-center rounded-lg bg-success-subtle px-3 text-xs font-semibold text-success-text transition-colors hover:bg-success hover:text-white"
        >
          {t('bankTable.done')}
        </button>
      </span>
    );
  };

  const stateChip = (line: Line) => {
    const state = stateOf(line);
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-content-secondary">
        <span className={cn('size-1.5 rounded-full', STATE_DOT[state])} aria-hidden />
        {t(STATE_STYLE[state].key)}
      </span>
    );
  };

  const Figure = ({ which, label, icon, tone }: { which: 'all' | 'waiting' | 'forwarded' | 'done'; label: string; icon: ReactNode; tone: string }) => {
    const figure = figures[which];
    const picked = show === which || (which === 'all' && show === 'all');
    return (
      <button
        type="button"
        onClick={() => setShow(which)}
        aria-pressed={picked}
        className={cn(
          'flex min-w-0 items-center gap-3 rounded-2xl bg-surface p-3 text-start shadow-[var(--shadow-sm)] ring-1 transition',
          picked ? 'ring-2 ring-primary' : 'ring-border-subtle hover:ring-primary/30',
        )}
      >
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl [&>svg]:size-5', tone)}>{icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-semibold text-content-tertiary">{label}</span>
          <span className="flex items-baseline gap-2">
            <span className="text-xl font-extrabold tabular-nums text-content">{desk ? figure.count : '…'}</span>
            {figure.late > 0 && which !== 'done' && (
              <span className="rounded-full bg-danger px-1.5 text-[10px] font-bold text-white tabular-nums">{figure.late}</span>
            )}
          </span>
          {figure.sum && (
            <Money value={figure.sum.amount} currency={figure.sum.currency} className="block truncate text-[11px] text-content-tertiary" />
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="space-y-3">
      {/* --- The day's figures, each a filter: one quiet strip --- */}
      <div className="flex gap-px overflow-x-auto rounded-2xl bg-border-subtle ring-1 ring-border-subtle [scrollbar-width:none] lg:grid lg:grid-cols-7 lg:overflow-hidden">
        {(
          [
            { key: 'all', label: t('bankTable.all'), dot: 'bg-content-tertiary', count: figures.all.count, late: figures.all.late, sum: figures.all.sum },
            { key: 'waiting', label: t('bankDesk.state.waiting'), dot: 'bg-warning', count: figures.waiting.count, late: figures.waiting.late, sum: figures.waiting.sum },
            { key: 'forwarded', label: t('bankDesk.state.forwarded'), dot: 'bg-primary', count: figures.forwarded.count, late: figures.forwarded.late, sum: figures.forwarded.sum },
            { key: 'done', label: t('bankDesk.state.done'), dot: 'bg-success', count: figures.done.count, late: 0, sum: figures.done.sum },
            { key: 'partial', label: t('bankParts.card'), dot: 'bg-warning', count: figures.partial.count, late: 0, sum: figures.partial.left, left: true, hint: t('bankParts.cardHint') },
            { key: 'short', label: t('bankParts.shortCard'), dot: 'bg-danger', count: figures.short.count, late: 0, sum: figures.short.left, left: true, alert: figures.short.count > 0, hint: t('bankParts.shortHint') },
            { key: 'unsorted', label: t('bankTable.unsorted'), dot: 'bg-danger', count: figures.unsorted, late: 0, sum: null, alert: figures.unsorted > 0, hint: t('bankTable.unsortedHint') },
          ] as { key: Show; label: string; dot: string; count: number; late: number; sum: { amount: string; currency: string } | null; left?: boolean; alert?: boolean; hint?: string }[]
        ).map((stat) => {
          const picked = show === stat.key;
          return (
            <button
              key={stat.key}
              type="button"
              onClick={() => setShow(picked && stat.key !== 'all' ? 'all' : stat.key)}
              aria-pressed={picked}
              title={stat.hint}
              className={cn(
                'relative min-w-[8.5rem] shrink-0 bg-surface px-4 py-3 text-start transition-colors hover:bg-surface-sunken/50 lg:min-w-0',
                picked && 'bg-primary-subtle/30',
              )}
            >
              <span className="flex items-center gap-1.5 truncate text-[11px] font-medium text-content-tertiary">
                <span className={cn('size-1.5 shrink-0 rounded-full', stat.dot)} aria-hidden />
                {stat.label}
              </span>
              <span className="mt-1 flex items-baseline gap-2">
                <span className={cn('text-2xl font-bold tabular-nums tracking-tight', stat.alert ? 'text-danger-text' : 'text-content')}>
                  {desk ? stat.count : '…'}
                </span>
                {stat.late > 0 && (
                  <span className="text-[11px] font-semibold text-danger-text">{t('bankTable.lateCount', { count: stat.late })}</span>
                )}
              </span>
              {stat.sum && (
                <span className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11px] text-content-tertiary">
                  {stat.left && t('bankParts.left')}
                  <Money value={stat.sum.amount} currency={stat.sum.currency} />
                </span>
              )}
              {picked && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-primary" aria-hidden />}
            </button>
          );
        })}
      </div>

      <Card className="overflow-hidden p-0">
        {/* --- Finding: the search, the days, the bank, the rest of the group's talk --- */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle p-2.5">
          <label className="flex h-10 min-w-[14rem] flex-1 items-center gap-2 rounded-xl bg-surface-sunken px-3 ring-1 ring-border-subtle focus-within:ring-primary/40">
            <Search className="size-4 shrink-0 text-content-tertiary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('bankTable.search')}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-content-tertiary"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label={t('common.clear')}>
                <X className="size-4 text-content-tertiary" />
              </button>
            )}
          </label>
          <DateRangePicker value={days} onChange={setDays} className="h-10" />
          <select
            value={channel ?? ''}
            onChange={(event) => setChannel(event.target.value || null)}
            className="h-10 rounded-xl bg-surface-sunken px-3 text-sm font-semibold text-content outline-none ring-1 ring-border-subtle"
            aria-label={t('bankTable.bank')}
          >
            <option value="">{t('bankTable.allBanks')}</option>
            {banks.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShow(show === 'messages' ? 'all' : 'messages')}
            aria-pressed={show === 'messages'}
            className={cn(
              'inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold ring-1',
              show === 'messages' ? 'bg-primary-subtle text-primary-text ring-primary/30' : 'text-content-secondary ring-border-subtle hover:bg-surface-sunken',
            )}
          >
            {t('bankDesk.show.messages')}
            <span className="tabular-nums opacity-70">{figures.messages}</span>
          </button>
          <button
            type="button"
            onClick={() => void load()}
            aria-label={t('common.refresh')}
            className="inline-flex size-10 items-center justify-center rounded-xl text-content-tertiary ring-1 ring-border-subtle hover:bg-surface-sunken"
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </button>
          {(searched || olderWaiting > 0 || !onToday || channel) && (
            <div className="flex w-full flex-wrap items-center gap-2 text-[11px] font-semibold">
              {searched && (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2 py-0.5 text-primary-text">
                  <Search className="size-3" />
                  {t('bank.searchAllDays')}
                </span>
              )}
              {olderWaiting > 0 && (
                <button
                  type="button"
                  onClick={() => setShow('open')}
                  className="inline-flex items-center gap-1 rounded-full bg-warning-subtle/70 px-2 py-0.5 text-warning-text"
                >
                  {t('bank.olderWaiting', { count: olderWaiting })}
                </button>
              )}
              {(!onToday || channel) && (
                <button
                  type="button"
                  onClick={() => {
                    setDays(today());
                    setChannel(null);
                    setShow('all');
                  }}
                  className="ms-auto inline-flex items-center gap-1 text-content-tertiary hover:text-danger-text"
                >
                  <X className="size-3" />
                  {t('bankTable.backToToday')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* --- The table, from a tablet up --- */}
        {!desk ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<Inbox />} title={t('bank.emptyTitle')} description={t('bank.emptyBody')} />
        ) : (
          <>
            <div className="hidden max-h-[calc(100dvh-22rem)] min-h-[20rem] overflow-auto md:block">
              <table className="w-full border-separate border-spacing-0 text-sm">
                <thead className="sticky top-0 z-10 bg-surface-sunken text-[11px] font-semibold text-content-tertiary">
                  <tr>
                    <th className="w-10 border-b border-border-subtle px-2 py-2">
                      <button
                        type="button"
                        onClick={() =>
                          setChecked(allTicked ? new Set() : new Set(tickable.map((line) => keyOf(line))))
                        }
                        aria-label={t('bankTable.tickAll')}
                        disabled={tickable.length === 0}
                        className="inline-flex text-content-tertiary hover:text-primary-text disabled:opacity-30"
                      >
                        {allTicked ? <CheckSquare className="size-4 text-primary-text" /> : <Square className="size-4" />}
                      </button>
                    </th>
                    <th className="border-b border-border-subtle px-2 py-2 text-start">{t('bankTable.time')}</th>
                    <th className="border-b border-border-subtle px-2 py-2 text-start">{t('bankTable.bank')}</th>
                    <th className="border-b border-border-subtle px-2 py-2 text-start">{t('bank.account')}</th>
                    <th className="border-b border-border-subtle px-2 py-2 text-start">{t('bank.name')}</th>
                    <th className="border-b border-border-subtle px-2 py-2 text-end">{t('bank.amount')}</th>
                    <th className="border-b border-border-subtle px-2 py-2 text-start">{t('bankTable.state')}</th>
                    <th className="border-b border-border-subtle px-2 py-2 text-start">{t('bankTable.waited')}</th>
                    <th className="border-b border-border-subtle px-2 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((line, index) => {
                    const key = keyOf(line);
                    const late = lateness(line, now);
                    const newDay = searched || index === 0 || dayKey(rows[index - 1]!.at) !== dayKey(line.at);
                    return (
                      <tr
                        key={key}
                        onClick={() => onOpen(line)}
                        className={cn(
                          'cursor-pointer transition-colors',
                          selectedKey === key ? 'bg-primary-subtle/60' : checked.has(key) ? 'bg-primary-subtle/30' : 'hover:bg-surface-sunken/70',
                        )}
                      >
                        <td
                          className={cn(
                            'border-b border-s-2 border-border-subtle px-2 py-2.5',
                            late === 'veryLate' ? 'border-s-danger/70' : late === 'late' ? 'border-s-warning/70' : 'border-s-transparent',
                          )}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {pendingOf(line) && (
                            <button type="button" onClick={() => toggle(line)} aria-label={t('bankTable.tick')} className="inline-flex">
                              {checked.has(key) ? <CheckSquare className="size-4 text-primary-text" /> : <Square className="size-4 text-content-tertiary" />}
                            </button>
                          )}
                        </td>
                        <td className="whitespace-nowrap border-b border-border-subtle px-2 py-2">
                          <span className="block font-semibold tabular-nums text-content">{clockOf(line.at)}</span>
                          {carried(line) ? (
                            <span
                              className="mt-0.5 block text-[10px] font-medium text-warning-text"
                              title={new Date(line.at).toLocaleString(locale === 'ar' ? 'ar' : 'en-GB')}
                            >
                              {t('bankTable.carried', {
                                day: dayLabel(dayKey(line.at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') }),
                              })}
                            </span>
                          ) : (
                            newDay &&
                            !onToday && (
                              <span className="block text-[10px] text-content-tertiary">
                                {dayLabel(dayKey(line.at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') })}
                              </span>
                            )
                          )}
                        </td>
                        <td className="border-b border-border-subtle px-2 py-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <BankMark line={line} className="size-7 text-[10px]" />
                            <span className="min-w-0">
                              <span className="block max-w-[9rem] truncate font-semibold text-content">{line.channel ?? '—'}</span>
                              <span className="block max-w-[9rem] truncate text-[10px] text-content-tertiary">{line.kind}</span>
                            </span>
                          </span>
                        </td>
                        <td className="border-b border-border-subtle px-1 py-2">
                          <CopyCell value={line.account} label={t('bank.account')} className="font-mono font-semibold tabular-nums ltr-content">
                            {line.account}
                          </CopyCell>
                        </td>
                        <td className="max-w-[14rem] border-b border-border-subtle px-1 py-2">
                          {line.source === 'message' && !line.name ? (
                            // A message not read: its words, as they came, to know it before opening it.
                            <span className="line-clamp-2 whitespace-pre-line px-1.5 text-xs text-content-secondary">
                              {(line.text ?? '').replace(/\n\s*\n+/g, '\n').trim() || '📎'}
                            </span>
                          ) : (
                            <CopyCell value={line.name} label={t('bank.name')} className="font-semibold text-content">
                              {line.name}
                            </CopyCell>
                          )}
                        </td>
                        <td className="border-b border-border-subtle px-1 py-2 text-end">
                          {BigInt(line.amount || '0') > 0n ? (
                            <>
                              <CopyCell
                                value={plainFigure(line.paid ? remainingOf(line.amount, line.paid).toString() : line.amount)}
                                label={line.paid ? t('bankParts.left') : t('bank.amount')}
                                className="font-bold"
                              >
                                <Money value={line.amount} currency={line.currency} />
                              </CopyCell>
                              <PartsBar
                                amount={line.amount}
                                paid={line.paid}
                                currency={line.currency}
                                closed={stateOf(line) === 'done'}
                                className="ms-auto mt-0.5 max-w-[9rem]"
                              />
                            </>
                          ) : (
                            <span className="text-content-tertiary">—</span>
                          )}
                        </td>
                        <td className="border-b border-border-subtle px-2 py-2">
                          {stateChip(line)}
                          {(line.forwardedTo?.length ?? 0) > 0 && stateOf(line) !== 'done' && (
                            <span className="mt-0.5 block max-w-[8rem] truncate text-[10px] text-primary-text">
                              {line.forwardedTo!.map((entry) => entry.group).join('، ')}
                            </span>
                          )}
                        </td>
                        <td className="border-b border-border-subtle px-2 py-2">{waitedChip(line)}</td>
                        <td className="border-b border-border-subtle px-2 py-2" onClick={(event) => event.stopPropagation()}>
                          <Actions line={line} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* --- On a phone: the same, as cards --- */}
            <ul className="divide-y divide-border-subtle md:hidden">
              {rows.map((line) => {
                const key = keyOf(line);
                const late = lateness(line, now);
                return (
                  <li
                    key={key}
                    onClick={() => onOpen(line)}
                    className={cn(
                      'border-s-2 p-3',
                      late === 'veryLate' ? 'border-s-danger/70' : late === 'late' ? 'border-s-warning/70' : 'border-s-transparent',
                      selectedKey === key && 'bg-primary-subtle/50',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {pendingOf(line) && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(line);
                          }}
                          aria-label={t('bankTable.tick')}
                        >
                          {checked.has(key) ? <CheckSquare className="size-5 text-primary-text" /> : <Square className="size-5 text-content-tertiary" />}
                        </button>
                      )}
                      <BankMark line={line} className="size-8 text-[10px]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-bold text-content">{line.name ?? line.text ?? '—'}</span>
                        <span className="block truncate text-xs text-content-tertiary">
                          {line.channel ?? '—'} · {clockOf(line.at)}
                          {carried(line) && (
                            <span className="ms-1 font-semibold text-warning-text">
                              ·{' '}
                              {t('bankTable.carried', {
                                day: dayLabel(dayKey(line.at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') }),
                              })}
                            </span>
                          )}
                        </span>
                      </span>
                      {BigInt(line.amount || '0') > 0n && (
                        <span className="shrink-0 text-end">
                          <Money value={line.amount} currency={line.currency} className="font-extrabold" />
                          <PartsBar
                            amount={line.amount}
                            paid={line.paid}
                            currency={line.currency}
                            closed={stateOf(line) === 'done'}
                            className="mt-0.5 w-28"
                          />
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <CopyCell value={line.account} label={t('bank.account')} className="bg-surface-sunken font-mono text-xs font-semibold ltr-content">
                        {line.account}
                      </CopyCell>
                      {stateChip(line)}
                      {waitedChip(line)}
                      <span className="ms-auto" onClick={(event) => event.stopPropagation()}>
                        <Actions line={line} />
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      {/* --- Several ticked: copied, or sent, together --- */}
      {ticked.length > 0 && (
        <div className="sticky bottom-3 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-2xl bg-content px-3 py-2 text-sm text-surface shadow-[var(--shadow-lg)]">
          <span className="font-bold">{t('bankTable.ticked', { count: ticked.length })}</span>
          <Button size="sm" variant="secondary" icon={<Copy />} onClick={copyTicked}>
            {t('bankTable.copyTicked')}
          </Button>
          <Button size="sm" variant="primary" icon={<CheckCircle2 />} onClick={() => setConfirming(true)}>
            {t('bankTable.sendTicked')}
          </Button>
          <button
            type="button"
            onClick={() => setChecked(new Set())}
            aria-label={t('common.cancel')}
            className="inline-flex size-8 items-center justify-center rounded-full hover:bg-surface/10"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void sendTicked()}
        title={t('bankTable.sendTickedTitle', { count: ticked.length })}
        message={t('bankTable.sendTickedHint')}
        confirmLabel={t('bankTable.sendTicked')}
        cancelLabel={t('common.cancel')}
        loading={sending}
      />
    </div>
  );
}
