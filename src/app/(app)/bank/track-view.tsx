'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  CornerUpRight,
  ExternalLink,
  Gauge,
  Hourglass,
  Inbox,
  ListChecks,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Search,
  Timer,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { Card, EmptyState, Skeleton } from '@/ui/primitives';
import { Money } from '@/ui/display';
import { ANY_DAY, DateRangePicker, type DayRange } from '@/ui/date-range-picker';
import { cn } from '@/ui/utils';
import { BankMark, LATE_AFTER, VERY_LATE_AFTER } from './bank-view';
import { clockOf, dayKey, dayLabel } from './days';
import type { Line } from './desk-types';
import { PartsBar } from './parts';

/**
 * The bank desk's watch over every transfer: each one followed from where it
 * began to where it was carried out, one row each — recorded, in the bank
 * group, passed on, sent, its receipt — with the time each step took, and the
 * one still waiting counting up in orange after a quarter of an hour and red
 * after half. The day's figures across the top, and what just happened down
 * the side, as it happens.
 */

type StageKey = 'recorded' | 'posted' | 'forwarded' | 'done' | 'receipt';
type Via = 'desk' | 'heart' | 'whatsapp' | 'rule';

interface Stage {
  at: string;
  by: string | null;
  group?: string | null;
  via?: Via;
}

interface Row {
  key: string;
  line: Line;
  stages: Partial<Record<StageKey, Stage>>;
}

interface TrackEvent {
  key: string;
  stage: StageKey;
  at: string;
  by: string | null;
  group: string | null;
  via: Via | null;
  amount: string;
  currency: string;
  name: string | null;
  channel: string | null;
}

interface Track {
  group: { id: string; name: string } | null;
  rows: Row[];
  events: TrackEvent[];
  summary: {
    total: number;
    waiting: number;
    forwarded: number;
    done: number;
    late: number;
    veryLate: number;
    avgForward: number | null;
    avgDone: number | null;
  };
}

const STAGES: StageKey[] = ['recorded', 'posted', 'forwarded', 'done', 'receipt'];

const STAGE_ICON: Record<StageKey, ReactNode> = {
  recorded: <CircleDot className="size-3.5" />,
  posted: <MessageSquare className="size-3.5" />,
  forwarded: <CornerUpRight className="size-3.5" />,
  done: <CheckCircle2 className="size-3.5" />,
  receipt: <Paperclip className="size-3.5" />,
};

const POLL_MS = 20_000;

type Show = 'all' | 'open' | 'late' | 'done';

const minutesBetween = (from: string, to: number) => Math.max(0, (to - new Date(from).getTime()) / 60_000);

export function TrackView({ onOpen }: { onOpen: (line: Line) => void }) {
  const { t, locale } = useLocale();
  const [data, setData] = useState<Track | null>(null);
  const [failed, setFailed] = useState(false);
  const [days, setDays] = useState<DayRange>(ANY_DAY);
  const [show, setShow] = useState<Show>('all');
  const [needle, setNeedle] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
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
      setData(await api.get<Track>(`/api/bank/track${asked}`));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, [days]);

  // Live: asked again every little while, and the clocks tick between.
  useEffect(() => {
    void load();
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [load]);

  /** A span of minutes as the counter says it: "7 د", "1 س 20 د". */
  const span = useCallback(
    (minutes: number) => {
      const whole = Math.round(minutes);
      if (whole < 60) return t('bankTrack.minutes', { n: whole });
      if (whole < 24 * 60) return t('bankTrack.hours', { h: Math.floor(whole / 60), m: whole % 60 });
      return t('bankTrack.days', { d: Math.floor(whole / 1440), h: Math.floor((whole % 1440) / 60) });
    },
    [t],
  );

  const lateOf = (row: Row): 'ok' | 'late' | 'veryLate' => {
    if (row.stages.done) return 'ok';
    const waited = minutesBetween(row.stages.recorded?.at ?? row.line.at, now);
    return waited >= VERY_LATE_AFTER ? 'veryLate' : waited >= LATE_AFTER ? 'late' : 'ok';
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const folded = needle.trim().toLowerCase();
    return data.rows
      .filter((row) => {
        if (show === 'open' && row.stages.done) return false;
        if (show === 'done' && !row.stages.done) return false;
        if (show === 'late' && lateOf(row) === 'ok') return false;
        if (!folded) return true;
        const amount = String(Number(row.line.amount) / 1e8);
        return [row.line.name, row.line.account, row.line.channel, row.line.reference, amount]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(folded));
      })
      // Open first, the longest waiting at the top; then what was done, newest first.
      .sort((a, b) => {
        if (Boolean(a.stages.done) !== Boolean(b.stages.done)) return a.stages.done ? 1 : -1;
        if (!a.stages.done) return new Date(a.line.at).getTime() - new Date(b.line.at).getTime();
        return new Date(b.stages.done!.at).getTime() - new Date(a.stages.done!.at).getTime();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, show, needle, now]);

  const rowByKey = useMemo(() => new Map((data?.rows ?? []).map((row) => [row.key, row])), [data]);

  const viaText = (stage: Stage | undefined) => (stage?.via ? t(`bankTrack.via.${stage.via}`) : null);

  return (
    <div className="space-y-3">
      {/* --- The day's figures --- */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Figure icon={<ListChecks />} label={t('bankTrack.total')} value={data?.summary.total} />
        <Figure icon={<Inbox />} label={t('bankTrack.waiting')} value={data?.summary.waiting} tone="warning" />
        <Figure icon={<CornerUpRight />} label={t('bankTrack.forwarded')} value={data?.summary.forwarded} tone="primary" />
        <Figure
          icon={<Hourglass />}
          label={t('bankTrack.late')}
          value={data?.summary.late}
          tone={data && data.summary.veryLate > 0 ? 'danger' : 'warning'}
          note={data && data.summary.veryLate > 0 ? `${data.summary.veryLate} +${VERY_LATE_AFTER}` : undefined}
          onClick={() => setShow('late')}
        />
        <Figure icon={<CheckCircle2 />} label={t('bankTrack.done')} value={data?.summary.done} tone="success" />
        <Figure
          icon={<Gauge />}
          label={t('bankTrack.avgDone')}
          value={data?.summary.avgDone != null ? span(data.summary.avgDone) : '—'}
          note={
            data?.summary.avgForward != null
              ? `${t('bankTrack.avgForward')}: ${span(data.summary.avgForward)}`
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
        {/* --- Every transfer, followed --- */}
        <Card className="flex min-h-[28rem] flex-col overflow-hidden p-0">
          <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle p-2.5">
            <label className="flex h-9 min-w-[12rem] flex-1 items-center gap-2 rounded-full bg-surface-sunken px-3 ring-1 ring-border-subtle focus-within:ring-primary/40">
              <Search className="size-4 shrink-0 text-content-tertiary" />
              <input
                value={needle}
                onChange={(event) => setNeedle(event.target.value)}
                placeholder={t('bankTrack.search')}
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-content-tertiary"
              />
              {needle && (
                <button type="button" onClick={() => setNeedle('')} aria-label={t('common.clear')}>
                  <X className="size-3.5 text-content-tertiary" />
                </button>
              )}
            </label>
            <DateRangePicker value={days} onChange={setDays} className="h-9" />
            <div className="inline-flex rounded-full bg-surface-sunken p-0.5 ring-1 ring-border-subtle">
              {(['all', 'open', 'late', 'done'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setShow(option)}
                  className={cn(
                    'h-8 rounded-full px-3 text-xs font-semibold transition-colors',
                    show === option
                      ? option === 'late'
                        ? 'bg-warning text-white'
                        : 'bg-surface text-content shadow-[var(--shadow-sm)]'
                      : 'text-content-tertiary hover:text-content-secondary',
                  )}
                >
                  {t(`bankTrack.show.${option}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => void load()}
              aria-label={t('bankTrack.live')}
              title={t('bankTrack.live')}
              className="inline-flex size-9 items-center justify-center rounded-full text-content-tertiary ring-1 ring-border-subtle hover:bg-surface-sunken hover:text-content"
            >
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            </button>
          </div>

          {/* The steps' names, above the rows' tracks. */}
          <div className="hidden grid-cols-[15rem_minmax(0,1fr)_7.5rem] items-center gap-3 border-b border-border-subtle bg-surface-sunken/60 px-3 py-1.5 text-[11px] font-semibold text-content-tertiary md:grid">
            <span />
            <span className="grid grid-cols-5 text-center">
              {STAGES.map((stage) => (
                <span key={stage}>{t(`bankTrack.stage.${stage}`)}</span>
              ))}
            </span>
            <span />
          </div>

          <div className="min-h-0 flex-1 divide-y divide-border-subtle overflow-y-auto">
            {failed ? (
              <p className="p-6 text-center text-sm text-danger-text">{t('errors.generic')}</p>
            ) : !data ? (
              <div className="space-y-2 p-3">
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
                <Skeleton className="h-16" />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<Activity />}
                title={data.rows.length ? t('bankTrack.noMatch') : t('bankTrack.empty')}
              />
            ) : (
              rows.map((row) => {
                const late = lateOf(row);
                const waited = minutesBetween(row.stages.recorded?.at ?? row.line.at, now);
                const took = row.stages.done
                  ? minutesBetween(row.stages.recorded?.at ?? row.line.at, new Date(row.stages.done.at).getTime())
                  : null;
                const expanded = open === row.key;
                // The step it waits at: the first not yet reached, a missing group message passed over.
                const next = row.stages.done
                  ? undefined
                  : STAGES.find((stage) => !row.stages[stage] && stage !== 'posted' && stage !== 'receipt');
                return (
                  <div
                    key={row.key}
                    id={`track-${row.key}`}
                    className={cn(
                      'border-s-4 transition-colors',
                      late === 'veryLate'
                        ? 'border-s-danger bg-danger-subtle/30'
                        : late === 'late'
                          ? 'border-s-warning bg-warning-subtle/30'
                          : row.stages.done
                            ? 'border-s-success/60'
                            : 'border-s-transparent',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : row.key)}
                      className="grid w-full grid-cols-1 items-center gap-2 px-3 py-2.5 text-start hover:bg-surface-sunken/60 md:grid-cols-[15rem_minmax(0,1fr)_7.5rem] md:gap-3"
                    >
                      {/* The transfer. */}
                      <span className="flex min-w-0 items-center gap-2.5">
                        <BankMark line={row.line} className="size-9 text-[11px]" />
                        <span className="min-w-0">
                          <span className="flex items-baseline gap-1.5">
                            <Money value={row.line.amount} currency={row.line.currency} className="text-sm font-bold text-content" />
                          </span>
                          <PartsBar amount={row.line.amount} paid={row.line.paid} currency={row.line.currency} className="w-32" />
                          <span className="block truncate text-xs text-content-secondary">
                            {row.line.name ?? row.line.account ?? '—'}
                            {row.line.channel && <span className="text-content-tertiary"> · {row.line.channel}</span>}
                          </span>
                        </span>
                      </span>

                      {/* Its way, step by step, with the time between. */}
                      <span className="grid grid-cols-5 items-start">
                        {STAGES.map((stage, index) => {
                          const reached = row.stages[stage];
                          const previous = STAGES.slice(0, index)
                            .map((key) => row.stages[key])
                            .filter(Boolean)
                            .at(-1);
                          const gap = reached && previous ? minutesBetween(previous.at, new Date(reached.at).getTime()) : null;
                          const current = !reached && stage === next;
                          return (
                            <span key={stage} className="relative flex flex-col items-center text-center">
                              {index > 0 && (
                                <span
                                  aria-hidden
                                  className={cn(
                                    'absolute end-1/2 top-3 h-0.5 w-full -translate-y-1/2',
                                    reached ? 'bg-success' : 'bg-border-subtle',
                                  )}
                                />
                              )}
                              
                              <span
                                className={cn(
                                  'relative z-[1] flex size-6 items-center justify-center rounded-full ring-2 ring-surface',
                                  reached
                                    ? 'bg-success text-white'
                                    : current
                                      ? late === 'veryLate'
                                        ? 'animate-pulse bg-danger text-white'
                                        : late === 'late'
                                          ? 'animate-pulse bg-warning text-white'
                                          : 'bg-primary-subtle text-primary-text ring-primary/30'
                                      : 'bg-surface-sunken text-content-tertiary',
                                )}
                                title={t(`bankTrack.stage.${stage}`)}
                              >
                                {STAGE_ICON[stage]}
                              </span>
                              <span className="mt-1 text-[10px] tabular-nums text-content-tertiary ltr-content">
                                {reached ? clockOf(reached.at) : current ? '…' : '—'}
                              </span>
                              {index > 0 && gap !== null && gap >= 1 && (
                                <span className="text-[9px] font-semibold tabular-nums text-content-tertiary">+{span(gap)}</span>
                              )}
                              {stage === 'forwarded' && reached?.group && (
                                <span className="max-w-full truncate px-0.5 text-[9px] text-primary-text">{reached.group}</span>
                              )}
                            </span>
                          );
                        })}
                      </span>

                      {/* How long: waiting so far, or what it took. */}
                      <span className="flex items-center justify-between gap-2 md:justify-end">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums',
                            took !== null
                              ? 'bg-success-subtle text-success-text'
                              : late === 'veryLate'
                                ? 'bg-danger text-white'
                                : late === 'late'
                                  ? 'bg-warning text-white'
                                  : 'bg-surface-sunken text-content-secondary',
                          )}
                        >
                          {took !== null ? <CheckCircle2 className="size-3" /> : <Timer className="size-3" />}
                          {took !== null ? span(took) : span(waited)}
                        </span>
                        <ChevronDown className={cn('size-4 text-content-tertiary transition-transform', expanded && 'rotate-180')} />
                      </span>
                    </button>

                    {/* Opened: each step in words — when, who, where, how. */}
                    {expanded && (
                      <div className="grid gap-3 bg-surface-sunken/50 px-4 pb-3 pt-1 md:grid-cols-[minmax(0,1fr)_auto]">
                        <ol className="space-y-2 border-s-2 border-border-subtle ps-4">
                          {STAGES.map((stage) => {
                            const reached = row.stages[stage];
                            return (
                              <li key={stage} className="relative">
                                <span
                                  className={cn(
                                    'absolute -start-[1.4rem] top-0.5 flex size-4 items-center justify-center rounded-full ring-2 ring-surface',
                                    reached ? 'bg-success text-white' : 'bg-surface text-content-tertiary ring-border-subtle',
                                  )}
                                />
                                <p className={cn('text-xs font-semibold', reached ? 'text-content' : 'text-content-tertiary')}>
                                  {t(`bankTrack.stage.${stage}`)}
                                  {reached && (
                                    <span className="ms-2 font-normal text-content-tertiary tabular-nums">
                                      {dayLabel(dayKey(reached.at), locale, {
                                        today: t('bank.period.today'),
                                        yesterday: t('bank.period.yesterday'),
                                      })}{' '}
                                      · {clockOf(reached.at)}
                                    </span>
                                  )}
                                </p>
                                {reached ? (
                                  <p className="text-[11px] text-content-secondary">
                                    {[
                                      reached.by && t('bankTrack.by', { name: reached.by }),
                                      reached.group && (stage === 'forwarded' ? t('bankTrack.to', { group: reached.group }) : reached.group),
                                      viaText(reached),
                                    ]
                                      .filter(Boolean)
                                      .join(' · ') || '—'}
                                  </p>
                                ) : stage === 'posted' && row.stages.recorded ? (
                                  <p className="text-[11px] text-content-tertiary">{t('bankTrack.noPost')}</p>
                                ) : null}
                              </li>
                            );
                          })}
                        </ol>
                        <div className="flex flex-col items-start gap-2 md:items-end">
                          <span className="font-mono text-[11px] text-content-tertiary ltr-content">{row.line.reference}</span>
                          {row.line.account && (
                            <span className="font-mono text-sm font-semibold text-content ltr-content">{row.line.account}</span>
                          )}
                          <button
                            type="button"
                            onClick={() => onOpen(row.line)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-semibold text-white hover:bg-primary-hover"
                          >
                            <ExternalLink className="size-3.5" />
                            {t('bankTrack.openInDesk')}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Card>

        {/* --- What just happened --- */}
        <Card className="flex max-h-[calc(100dvh-16rem)] min-h-[20rem] flex-col overflow-hidden p-0">
          <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2.5">
            <h3 className="flex items-center gap-1.5 text-sm font-bold text-content">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-success" />
              </span>
              {t('bankTrack.log')}
            </h3>
            <span className="text-[10px] text-content-tertiary">{t('bankTrack.live')}</span>
          </div>
          <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
            {!data ? (
              <Skeleton className="h-40" />
            ) : data.events.length === 0 ? (
              <p className="p-4 text-center text-xs text-content-tertiary">{t('bankTrack.logEmpty')}</p>
            ) : (
              data.events.map((event, index) => (
                <li key={`${event.key}:${event.stage}:${index}`}>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(event.key);
                      setShow('all');
                      setNeedle('');
                      const row = rowByKey.get(event.key);
                      if (row) document.getElementById(`track-${row.key}`)?.scrollIntoView({ block: 'center' });
                    }}
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-surface-sunken"
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full',
                        event.stage === 'done'
                          ? 'bg-success-subtle text-success-text'
                          : event.stage === 'forwarded'
                            ? 'bg-primary-subtle text-primary-text'
                            : event.stage === 'receipt'
                              ? 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
                              : 'bg-surface-sunken text-content-secondary',
                      )}
                    >
                      {STAGE_ICON[event.stage]}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs font-semibold text-content">
                          {t(`bankTrack.stage.${event.stage}`)} ·{' '}
                          <Money value={event.amount} currency={event.currency} className="font-bold" />
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-content-tertiary">{clockOf(event.at)}</span>
                      </span>
                      <span className="block truncate text-[11px] text-content-secondary">
                        {[
                          event.name,
                          event.by && t('bankTrack.by', { name: event.by }),
                          event.stage === 'forwarded' && event.group && t('bankTrack.to', { group: event.group }),
                          event.via && t(`bankTrack.via.${event.via}`),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ol>
        </Card>
      </div>
    </div>
  );
}

/** One of the day's figures. */
function Figure({
  icon,
  label,
  value,
  tone = 'neutral',
  note,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: number | string | undefined;
  tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
  note?: string;
  onClick?: () => void;
}) {
  const toneClass = {
    neutral: 'bg-surface-sunken text-content-secondary',
    primary: 'bg-primary-subtle text-primary-text',
    success: 'bg-success-subtle text-success-text',
    warning: 'bg-warning-subtle text-warning-text',
    danger: 'bg-danger-subtle text-danger-text',
  }[tone];
  const Body = onClick ? 'button' : 'div';
  return (
    <Body
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'flex items-center gap-3 rounded-2xl bg-surface p-3 text-start shadow-[var(--shadow-sm)] ring-1 ring-border-subtle',
        onClick && 'transition hover:ring-primary/30',
      )}
    >
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl [&>svg]:size-5', toneClass)}>{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[11px] font-semibold text-content-tertiary">{label}</span>
        <span className="block text-xl font-extrabold leading-tight tabular-nums text-content">
          {value === undefined ? '…' : value}
        </span>
        {note && <span className="block truncate text-[10px] text-content-tertiary">{note}</span>}
      </span>
    </Body>
  );
}
