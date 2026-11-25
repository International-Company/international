'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CircleHelp,
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
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
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

type Show = 'all' | 'open' | 'waiting' | 'forwarded' | 'done' | 'messages' | 'unsorted' | 'partial' | 'short' | 'remain';

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
  remain: ['waiting', 'forwarded', 'done'],
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
  onExecuteRemainder,
  onFloatRemainder,
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
  /** What is left of one, sent: with its receipt, or settled by hand. */
  onExecuteRemainder?: (line: Line) => void;
  /** What is left of one, in the floating window. */
  onFloatRemainder?: (line: Line) => void;
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
  /** What is left of the transfers of the last fortnight, open or closed: the remainders' figure and list. */
  const [remains, setRemains] = useState<Line[] | null>(null);
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
      const [read, left] = await Promise.all([
        api.get<Desk>(`/api/bank${asked}`),
        api.get<{ lines: Line[] }>('/api/bank/remainders').catch(() => null),
      ]);
      setDesk(read);
      if (left) setRemains(left.lines);
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
      // Something left of it, sent in part or closed short: the remainders' figure.
      remain: (() => {
        const lines = (remains ?? []).filter((line) => remainingOf(line.amount, line.paid) > 0n);
        const left = new Map<string, bigint>();
        for (const line of lines) left.set(line.currency, (left.get(line.currency) ?? 0n) + remainingOf(line.amount, line.paid));
        const top = [...left.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1))[0];
        return { count: lines.length, left: top ? { currency: top[0], amount: top[1].toString() } : null };
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
  }, [everything, now, remains]);

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
  const rows = (show === 'remain' ? (remains ?? []).filter((line) => remainingOf(line.amount, line.paid) > 0n) : everything)
    .filter((line) => show === 'remain' || SHOWN[show].includes(stateOf(line)) && (show !== 'partial' || Boolean(line.paid)) && (show !== 'short' || remainingOf(line.amount, line.paid) > 0n && Boolean(line.paid)))
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

  /** A forwarded transfer asked after in the group it went to: the bot answers its copy, marked ❓. */
  const [inquiring, setInquiring] = useState<string | null>(null);
  /** The transfer being asked after, and the words to ask it with. */
  const [asking, setAsking] = useState<{ line: Line; text: string } | null>(null);
  const inquire = (line: Line) => setAsking({ line, text: t('bankAsk.default') });
  const sendInquiry = async () => {
    if (!asking?.line.messageId) return;
    const line = asking.line;
    setInquiring(keyOf(line));
    try {
      const result = await api.post<{ asked: string[] }>(`/api/bank/groups/messages/${line.messageId}/inquire`, {
        text: asking.text,
      });
      toast.success(t('bankAsk.done'), result.asked.join('، '));
      setAsking(null);
      onChanged();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      );
    } finally {
      setInquiring(null);
    }
  };
  /** The last time it was asked after, as the line shows it. */
  const askedOf = (line: Line) =>
    (line.forwardedTo ?? [])
      .filter((entry) => entry.inquiredAt)
      .sort((a, b) => new Date(b.inquiredAt!).getTime() - new Date(a.inquiredAt!).getTime())[0] ?? null;

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
    if (line.paid && remainingOf(line.amount, line.paid) > 0n && (onExecuteRemainder || onFloatRemainder)) {
      return (
        <span className="flex items-center justify-end gap-1">
          {line.messageId && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onForward(line);
              }}
              title={t('bankRem.forward')}
              aria-label={t('bankRem.forward')}
              className="inline-flex size-8 items-center justify-center rounded-lg text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-primary-text"
            >
              <CornerUpRight className="size-4" />
            </button>
          )}
          {onFloatRemainder && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onFloatRemainder(line);
              }}
              title={t('bankSent.floatRow')}
              aria-label={t('bankSent.floatRow')}
              className="inline-flex size-8 items-center justify-center rounded-lg text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-primary-text"
            >
              <PictureInPicture2 className="size-4" />
            </button>
          )}
          {onExecuteRemainder && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onExecuteRemainder(line);
              }}
              className="inline-flex h-8 items-center whitespace-nowrap rounded-lg bg-warning-subtle px-3 text-xs font-semibold text-warning-text transition-colors hover:bg-warning hover:text-white"
            >
              {t('bankRem.execute')}
            </button>
          )}
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
        {state === 'forwarded' && line.messageId && (
          <button
            type="button"
            disabled={inquiring === keyOf(line)}
            onClick={(event) => {
              event.stopPropagation();
              inquire(line);
            }}
            title={t('bankAsk.hint')}
            aria-label={t('bankAsk.button')}
            className="inline-flex size-8 items-center justify-center rounded-lg text-content-tertiary transition-colors hover:bg-warning-subtle hover:text-warning-text disabled:animate-pulse"
          >
            <CircleHelp className="size-4" />
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

  return (
    <div className="space-y-3">
      {/* --- The day's figures, each a filter --- */}
      <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-1 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0 xl:grid-cols-6">
        {(
          [
            { key: 'all', label: t('bankTable.all'), bar: 'bg-primary', count: figures.all.count, late: figures.all.late, sum: figures.all.sum },
            { key: 'waiting', label: t('bankDesk.state.waiting'), bar: 'bg-warning', count: figures.waiting.count, late: figures.waiting.late, sum: figures.waiting.sum },
            { key: 'forwarded', label: t('bankDesk.state.forwarded'), bar: 'bg-primary', count: figures.forwarded.count, late: figures.forwarded.late, sum: figures.forwarded.sum },
            { key: 'done', label: t('bankDesk.state.done'), bar: 'bg-success', count: figures.done.count, late: 0, sum: figures.done.sum },
            { key: 'remain', label: t('bankRem.card'), bar: 'bg-warning', count: figures.remain.count, late: 0, sum: figures.remain.left, left: true, tone: figures.remain.count > 0 ? 'text-warning-text' : undefined, hint: t('bankRem.cardHint') },
            { key: 'unsorted', label: t('bankTable.unsorted'), bar: 'bg-danger', count: figures.unsorted, late: 0, sum: null, tone: figures.unsorted > 0 ? 'text-danger-text' : undefined, hint: t('bankTable.unsortedHint') },
          ] as { key: Show; label: string; bar: string; count: number; late: number; sum: { amount: string; currency: string } | null; left?: boolean; tone?: string; hint?: string }[]
        ).map((stat) => {
          const picked = show === stat.key;
          const whole = Math.max(figures.all.count, 1);
          const share = stat.key === 'all' ? (figures.all.count ? 100 : 0) : Math.min(100, Math.round((stat.count / whole) * 100));
          return (
            <button
              key={stat.key}
              type="button"
              onClick={() => setShow(picked && stat.key !== 'all' ? 'all' : stat.key)}
              aria-pressed={picked}
              title={stat.hint}
              className={cn(
                'group relative flex min-w-[9.5rem] shrink-0 snap-start flex-col rounded-2xl bg-surface p-3.5 text-start ring-1 transition-all duration-200 sm:min-w-0 sm:p-4',
                picked
                  ? 'shadow-[0_8px_24px_-12px_rgb(37_99_235/0.45)] ring-2 ring-primary'
                  : 'shadow-[0_1px_2px_rgb(15_23_42/0.05)] ring-border-subtle hover:-translate-y-0.5 hover:shadow-[0_10px_24px_-14px_rgb(15_23_42/0.3)]',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className={cn('truncate text-[12px] font-medium', picked ? 'text-primary-text' : 'text-content-secondary')}>{stat.label}</span>
                {stat.late > 0 && (
                  <span className="shrink-0 rounded-full bg-danger-subtle px-2 py-0.5 text-[10px] font-semibold tabular-nums text-danger-text">
                    {t('bankTable.lateCount', { count: stat.late })}
                  </span>
                )}
              </span>
              <span className={cn('mt-2.5 text-[26px] font-semibold leading-none tabular-nums tracking-tight sm:text-[30px]', stat.tone ?? 'text-content')}>
                {desk ? stat.count : '…'}
              </span>
              <span className="mt-2 flex min-h-[16px] flex-wrap items-center gap-x-1 text-[12px] text-content-tertiary">
                {stat.sum && (
                  <>
                    {stat.left && t('bankParts.left')}
                    <Money value={stat.sum.amount} currency={stat.sum.currency} />
                  </>
                )}
              </span>
              <span className="mt-3 block h-1 overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
                <span className={cn('block h-full rounded-full transition-all duration-500', stat.bar)} style={{ width: `${share}%` }} />
              </span>
            </button>
          );
        })}
      </div>

      <Card className="overflow-hidden p-0">
        {/* --- Finding: the search, the days, the bank, the rest of the group's talk --- */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle p-2.5">
          <label className="flex h-10 w-full min-w-0 items-center gap-2 rounded-xl bg-surface-sunken px-3 ring-1 ring-border-subtle focus-within:ring-primary/40 sm:w-auto sm:min-w-[14rem] sm:flex-1">
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
            <div className="hidden max-h-[calc(100dvh-22rem)] min-h-[20rem] overflow-auto xl:block">
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
                          <span className="mt-0.5 block">{waitedChip(line)}</span>
                          {(line.forwardedTo?.length ?? 0) > 0 && stateOf(line) !== 'done' && (
                            <span className="mt-0.5 block max-w-[8rem] truncate text-[10px] text-primary-text">
                              {line.forwardedTo!.map((entry) => entry.group).join('، ')}
                            </span>
                          )}
                          {askedOf(line) && stateOf(line) !== 'done' && (
                            <span className="mt-0.5 block max-w-[9rem] truncate text-[10px] font-medium text-warning-text" title={askedOf(line)!.inquiredBy ?? ''}>
                              ❓ {t('bankAsk.asked', { at: clockOf(askedOf(line)!.inquiredAt!) })}
                            </span>
                          )}
                        </td>
                        <td className="border-b border-border-subtle px-2 py-2" onClick={(event) => event.stopPropagation()}>
                          <Actions line={line} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* --- Narrower than the table: each transfer as a card, in lines --- */}
            <ul className="divide-y divide-border-subtle xl:hidden">
              {rows.map((line) => {
                const key = keyOf(line);
                const late = lateness(line, now);
                return (
                  <li
                    key={key}
                    onClick={() => onOpen(line)}
                    className={cn(
                      'cursor-pointer border-s-2 px-3 py-3 transition-colors sm:px-4',
                      late === 'veryLate' ? 'border-s-danger/70' : late === 'late' ? 'border-s-warning/70' : 'border-s-transparent',
                      selectedKey === key ? 'bg-primary-subtle/50' : checked.has(key) ? 'bg-primary-subtle/30' : 'hover:bg-surface-sunken/60',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      {pendingOf(line) && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            toggle(line);
                          }}
                          aria-label={t('bankTable.tick')}
                          className="mt-2.5 shrink-0"
                        >
                          {checked.has(key) ? <CheckSquare className="size-[18px] text-primary-text" /> : <Square className="size-[18px] text-content-tertiary/70" />}
                        </button>
                      )}
                      <BankMark line={line} className="mt-0.5 size-10 text-[11px]" />
                      <div className="min-w-0 flex-1">
                        {/* To whom, and how much. */}
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="min-w-0 truncate text-[15px] font-semibold text-content">
                            {line.source === 'message' && !line.name
                              ? (line.text ?? '').replace(/\s+/g, ' ').trim() || '📎'
                              : (line.name ?? '—')}
                          </span>
                          {BigInt(line.amount || '0') > 0n && (
                            <Money value={line.amount} currency={line.currency} className="shrink-0 text-[15px] font-bold tabular-nums text-content" />
                          )}
                        </div>
                        {/* Where, and since when. */}
                        <div className="mt-1 flex items-start justify-between gap-3 text-[12px] leading-5 text-content-tertiary">
                          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            {line.account && (
                              <span onClick={(event) => event.stopPropagation()} className="-ms-1.5 shrink-0">
                                <CopyCell value={line.account} label={t('bank.account')} className="font-mono text-[12px] font-medium text-content-secondary ltr-content">
                                  {line.account}
                                </CopyCell>
                              </span>
                            )}
                            <span className="min-w-0">
                              {line.channel ?? '—'} · <span className="tabular-nums">{clockOf(line.at)}</span>
                              {carried(line) && (
                                <span className="font-medium text-warning-text">
                                  {' · '}
                                  {t('bankTable.carried', {
                                    day: dayLabel(dayKey(line.at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') }),
                                  })}
                                </span>
                              )}
                            </span>
                          </span>
                          <span className="shrink-0">{waitedChip(line)}</span>
                        </div>
                        {/* What is left of it, when sent in part. */}
                        {line.paid && (
                          <PartsBar
                            amount={line.amount}
                            paid={line.paid}
                            currency={line.currency}
                            closed={stateOf(line) === 'done'}
                            className="mt-2 max-w-xs"
                          />
                        )}
                        {/* Where it stands, and what is done with it. */}
                        <div className="mt-2.5 flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            {stateChip(line)}
                            {(line.forwardedTo?.length ?? 0) > 0 && stateOf(line) !== 'done' && (
                              <span className="truncate text-[11px] text-primary-text">
                                {line.forwardedTo!.map((entry) => entry.group).join('، ')}
                              </span>
                            )}
                            {askedOf(line) && stateOf(line) !== 'done' && (
                              <span className="shrink-0 text-[11px] font-medium text-warning-text">
                                ❓ {clockOf(askedOf(line)!.inquiredAt!)}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0" onClick={(event) => event.stopPropagation()}>
                            <Actions line={line} />
                          </span>
                        </div>
                      </div>
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

      {/* Asking after a forwarded transfer: the words are the person's own. */}
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        size="sm"
        title={t('bankAsk.title')}
        description={
          asking
            ? `${asking.line.name ?? asking.line.account ?? ''} · ${(asking.line.forwardedTo ?? []).map((entry) => entry.group).join('، ')}`
            : undefined
        }
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setAsking(null)} disabled={inquiring !== null}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={inquiring !== null}
              disabled={!asking?.text.trim()}
              onClick={() => void sendInquiry()}
            >
              {t('bankAsk.send')}
            </Button>
          </div>
        }
      >
        {asking && (
          <div className="space-y-2.5">
            <textarea
              autoFocus
              rows={3}
              maxLength={1000}
              value={asking.text}
              onChange={(event) => setAsking({ ...asking, text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void sendInquiry();
              }}
              className="w-full resize-none rounded-xl bg-surface-sunken p-3 text-sm text-content outline-none ring-1 ring-border-subtle focus:ring-2 focus:ring-primary/50"
            />
            <div className="flex flex-wrap gap-1.5">
              {(['q1', 'q2', 'q3', 'q4'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setAsking({ ...asking, text: t(`bankAsk.ready.${key}`) })}
                  className="rounded-full bg-surface-sunken px-2.5 py-1 text-[12px] font-medium text-content-secondary ring-1 ring-border-subtle transition-colors hover:bg-primary-subtle hover:text-primary-text"
                >
                  {t(`bankAsk.ready.${key}`)}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-content-tertiary">{t('bankAsk.sendHint')}</p>
          </div>
        )}
      </Dialog>

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
