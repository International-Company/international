'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, CornerUpRight, PictureInPicture2, RefreshCw, Search } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Card, EmptyState, Skeleton } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Money } from '@/ui/display';
import { DateRangePicker, keyOf as dayOf, type DayRange } from '@/ui/date-range-picker';
import { cn } from '@/ui/utils';
import { BankMark } from './bank-view';
import { clockOf, dayKey, dayLabel } from './days';
import { keyOf, plainFigure, stateOf, type Line } from './desk-types';
import { remainingOf } from './parts';

type Filter = 'all' | 'open' | 'closed' | 'forwarded';

/** The last fortnight, today included. */
const fortnight = (): DayRange => {
  const start = new Date();
  start.setDate(start.getDate() - 13);
  return { from: dayOf(start), to: dayOf(new Date()) };
};

/**
 * What is left of the transfers, each a transfer of its own: the sum still to
 * send, what it is left of, to whom — passed on to a group, sent from a
 * floating window, or settled — its receipt joining the transfer it came from.
 */
export function RemaindersView({
  version,
  onOpen,
  onForward,
  onExecute,
  onFloat,
}: {
  version: number;
  /** The transfer it is left of, opened in full. */
  onOpen: (line: Line) => void;
  /** Only what is left, passed on to a group. */
  onForward: (line: Line) => void;
  /** What is left, sent: with its receipt, or settled by hand. */
  onExecute: (line: Line) => void;
  onFloat: (line: Line) => void;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [lines, setLines] = useState<Line[] | null>(null);
  const [days, setDays] = useState<DayRange>(fortnight);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const edge = (key: string, end: boolean) => {
        const [year, month, day] = key.split('-').map(Number) as [number, number, number];
        return (end ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day)).toISOString();
      };
      const params = new URLSearchParams({
        from: days.from ? edge(days.from, false) : new Date(2000, 0, 1).toISOString(),
        ...(days.to ? { to: edge(days.to, true) } : {}),
      });
      setLines((await api.get<{ lines: Line[] }>(`/api/bank/remainders?${params.toString()}`)).lines);
    } catch (cause) {
      toast.error(t('errors.title'), cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'));
      setLines((current) => current ?? []);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, version]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (line: Line) => stateOf(line) === 'waiting' || stateOf(line) === 'forwarded';
  const words = query.trim();
  const digits = words.replace(/[^0-9]/g, '');
  const shown = useMemo(
    () =>
      (lines ?? [])
        .filter((line) =>
          filter === 'open'
            ? open(line)
            : filter === 'closed'
              ? !open(line)
              : filter === 'forwarded'
                ? (line.forwardedTo?.length ?? 0) > 0
                : true,
        )
        .filter(
          (line) =>
            !words ||
            (line.name ?? '').includes(words) ||
            line.reference.includes(words.toUpperCase()) ||
            (Boolean(digits) && (line.account ?? '').replace(/[^0-9]/g, '').includes(digits)),
        )
        // The biggest left first: what matters most is on top.
        .sort((a, b) => (remainingOf(b.amount, b.paid) > remainingOf(a.amount, a.paid) ? 1 : -1)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lines, filter, words, digits],
  );

  // The figures across the top: how many, and what is left of them all.
  const totals = useMemo(() => {
    const left = new Map<string, bigint>();
    for (const line of lines ?? []) left.set(line.currency, (left.get(line.currency) ?? 0n) + remainingOf(line.amount, line.paid));
    return [...left.entries()].sort((a, b) => (a[1] > b[1] ? -1 : 1));
  }, [lines]);
  const count = (which: Filter) =>
    (lines ?? []).filter((line) =>
      which === 'open' ? open(line) : which === 'closed' ? !open(line) : which === 'forwarded' ? (line.forwardedTo?.length ?? 0) > 0 : true,
    ).length;

  const copy = (value: string, what: string) => {
    void navigator.clipboard?.writeText(value);
    toast.success(t('bank.copied'), what);
  };
  const when = (at: string) =>
    `${dayLabel(dayKey(at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') })} · ${clockOf(at)}`;

  return (
    <div className="space-y-3">
      {/* --- What is left, in all --- */}
      <div className="flex gap-px overflow-x-auto rounded-2xl bg-border-subtle ring-1 ring-border-subtle [scrollbar-width:none] lg:grid lg:grid-cols-4">
        <div className="min-w-[12rem] shrink-0 bg-surface px-4 py-3 lg:min-w-0">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-content-tertiary">
            <span className="size-1.5 rounded-full bg-warning" aria-hidden />
            {t('bankRem.totalLeft')}
          </span>
          <span className="mt-1 block text-2xl font-bold tabular-nums tracking-tight text-warning-text">
            {lines === null ? '…' : totals[0] ? <Money value={totals[0][1].toString()} currency={totals[0][0]} /> : '0'}
          </span>
          {totals.slice(1).map(([currency, amount]) => (
            <Money key={currency} value={amount.toString()} currency={currency} className="block text-[11px] text-content-tertiary" />
          ))}
        </div>
        {(
          [
            { key: 'open', dot: 'bg-warning' },
            { key: 'forwarded', dot: 'bg-primary' },
            { key: 'closed', dot: 'bg-content-tertiary' },
          ] as const
        ).map((stat) => {
          const picked = filter === stat.key;
          return (
            <button
              key={stat.key}
              type="button"
              aria-pressed={picked}
              onClick={() => setFilter(picked ? 'all' : stat.key)}
              className={cn(
                'relative min-w-[8.5rem] shrink-0 bg-surface px-4 py-3 text-start transition-colors hover:bg-surface-sunken/50 lg:min-w-0',
                picked && 'bg-primary-subtle/30',
              )}
            >
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-content-tertiary">
                <span className={cn('size-1.5 rounded-full', stat.dot)} aria-hidden />
                {t(`bankRem.filter.${stat.key}`)}
              </span>
              <span className="mt-1 block text-2xl font-bold tabular-nums tracking-tight text-content">{lines === null ? '…' : count(stat.key)}</span>
              {picked && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-primary" aria-hidden />}
            </button>
          );
        })}
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle p-2.5">
          <label className="flex h-10 min-w-[14rem] flex-1 items-center gap-2 rounded-xl bg-surface-sunken px-3 ring-1 ring-border-subtle focus-within:ring-primary/40">
            <Search className="size-4 shrink-0 text-content-tertiary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('bankRem.search')}
              className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
          </label>
          <DateRangePicker value={days} onChange={setDays} className="h-10" />
          <button
            type="button"
            onClick={() => void load()}
            aria-label={t('common.refresh')}
            className="inline-flex size-10 items-center justify-center rounded-xl text-content-tertiary ring-1 ring-border-subtle hover:bg-surface-sunken"
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </button>
        </div>

        {lines === null ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-16" />
            <Skeleton className="h-16" />
          </div>
        ) : shown.length === 0 ? (
          <div className="p-8">
            <EmptyState title={t('bankRem.none')} description={t('bankRem.noneHint')} />
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {shown.map((line) => {
              const left = remainingOf(line.amount, line.paid);
              const share = Math.min(100, Number((BigInt(line.paid ?? '0') * 100n) / (BigInt(line.amount) || 1n)));
              const isOpen = open(line);
              return (
                <li
                  key={keyOf(line)}
                  className="grid items-center gap-x-4 gap-y-2 px-3 py-3 transition-colors hover:bg-surface-sunken/40 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.1fr)_auto]"
                >
                  {/* To whom. */}
                  <button type="button" onClick={() => onOpen(line)} className="flex min-w-0 items-center gap-3 text-start">
                    <BankMark line={line} className="size-9 text-[11px]" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-content">{line.name ?? '—'}</span>
                      <span className="flex items-center gap-1.5 text-[11px] text-content-tertiary">
                        <span className="truncate">{line.channel ?? '—'}</span>
                        {line.account && (
                          <span
                            role="button"
                            tabIndex={0}
                            onClick={(event) => {
                              event.stopPropagation();
                              copy(line.account!, t('bank.account'));
                            }}
                            className="group/acc inline-flex items-center gap-1 rounded px-1 font-mono tabular-nums text-content-secondary hover:bg-primary-subtle/60 ltr-content"
                          >
                            {line.account}
                            <Copy className="size-2.5 opacity-0 group-hover/acc:opacity-70" />
                          </span>
                        )}
                      </span>
                    </span>
                  </button>

                  {/* What it is left of. */}
                  <span className="min-w-0 text-[11px] text-content-tertiary">
                    <span className="block">
                      {t('bankRem.of')}{' '}
                      <Money value={line.amount} currency={line.currency} className="font-semibold text-content-secondary" />
                    </span>
                    <span className="block truncate">
                      <span className="ltr-content font-mono">{line.reference}</span> · {when(line.at)}
                    </span>
                  </span>

                  {/* What is left, and how far it has gone. */}
                  <span className="min-w-0">
                    <button
                      type="button"
                      onClick={() => copy(plainFigure(left.toString()), t('bankParts.left'))}
                      title={t('bankRem.copyLeft')}
                      className="group/left inline-flex items-center gap-1.5 rounded-md px-1 text-start hover:bg-warning-subtle/60"
                    >
                      <Money value={left.toString()} currency={line.currency} className="text-lg font-bold tracking-tight text-warning-text" />
                      <Copy className="size-3 text-warning-text opacity-0 group-hover/left:opacity-70" />
                    </button>
                    <span className="mt-1 block h-1 w-full max-w-[12rem] overflow-hidden rounded-full bg-surface-sunken">
                      <span className="block h-full rounded-full bg-warning/80" style={{ width: `${share}%` }} />
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px]">
                      <span className="inline-flex items-center gap-1 text-content-tertiary">
                        <span className={cn('size-1.5 rounded-full', isOpen ? 'bg-warning' : 'bg-content-tertiary')} aria-hidden />
                        {isOpen ? t('bankRem.originOpen') : t('bankRem.originClosed')}
                      </span>
                      {(line.forwardedTo?.length ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 text-primary-text">
                          <CornerUpRight className="size-3" />
                          {line.forwardedTo!.map((entry) => entry.group).join('، ')}
                        </span>
                      )}
                    </span>
                  </span>

                  {/* What is done with it. */}
                  <span className="flex items-center justify-end gap-1">
                    {line.messageId && (
                      <button
                        type="button"
                        onClick={() => onForward(line)}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-content-secondary transition-colors hover:bg-surface-sunken hover:text-primary-text"
                      >
                        <CornerUpRight className="size-3.5" />
                        {t('bankRem.forward')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onFloat(line)}
                      title={t('bankSent.floatRow')}
                      aria-label={t('bankSent.floatRow')}
                      className="inline-flex size-8 items-center justify-center rounded-lg text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-primary-text"
                    >
                      <PictureInPicture2 className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onExecute(line)}
                      className="inline-flex h-8 items-center rounded-lg bg-success-subtle px-3 text-xs font-semibold text-success-text transition-colors hover:bg-success hover:text-white"
                    >
                      {t('bankRem.execute')}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
