'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, MessageSquareX, RefreshCw, Search, Undo2, UserRound } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Card, EmptyState, Skeleton } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Money } from '@/ui/display';
import { DateRangePicker, keyOf as dayOf, type DayRange } from '@/ui/date-range-picker';
import { cn } from '@/ui/utils';

interface Cancelled {
  key: string;
  kind: 'deal' | 'request';
  id: string;
  reference: string | null;
  name: string | null;
  account: string | null;
  channel: string | null;
  amount: string;
  currency: string;
  madeAt: string;
  wasSent: boolean;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelledByEn: string | null;
  reason: string | null;
  reversal: string | null;
  group: string | null;
}

/** The last thirty days, today included. */
const lastMonth = (): DayRange => {
  const start = new Date();
  start.setDate(start.getDate() - 29);
  return { from: dayOf(start), to: dayOf(new Date()) };
};

const stamp = (value: string) =>
  new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );

/**
 * What was cancelled on the desk: the counter's transfers that were reversed
 * and the groups' requests taken off the list — each with who did it, when,
 * and, for a reversal, why.
 */
export function CancelledView() {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [days, setDays] = useState<DayRange>(lastMonth);
  const [rows, setRows] = useState<Cancelled[] | null>(null);
  const [kind, setKind] = useState<'all' | 'deal' | 'request'>('all');
  const [who, setWho] = useState('');
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
      setRows((await api.get<{ rows: Cancelled[] }>(`/api/bank/cancelled?${params.toString()}`)).rows);
    } catch (cause) {
      toast.error(t('errors.title'), cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'));
      setRows((current) => current ?? []);
    } finally {
      setLoading(false);
    }
  }, [days, toast, t]);
  useEffect(() => {
    void load();
  }, [load]);

  const byName = (row: Cancelled) => (locale === 'ar' ? row.cancelledBy : row.cancelledByEn) ?? row.cancelledBy;
  const people = useMemo(
    () => [...new Set((rows ?? []).map(byName).filter((name): name is string => Boolean(name)))].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, locale],
  );
  const words = query.trim();
  const digits = words.replace(/\D/g, '');
  const shown = (rows ?? []).filter(
    (row) =>
      (kind === 'all' || row.kind === kind) &&
      (!who || byName(row) === who) &&
      (!words ||
        (row.name ?? '').includes(words) ||
        (row.reference ?? '').includes(words.toUpperCase()) ||
        (row.reason ?? '').includes(words) ||
        (Boolean(digits) && (row.account ?? '').includes(digits))),
  );
  const count = (value: 'deal' | 'request') => (rows ?? []).filter((row) => row.kind === value).length;

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle p-3">
        <label className="flex h-10 min-w-[12rem] flex-1 items-center gap-2 rounded-xl bg-surface-sunken px-3 ring-1 ring-border-subtle">
          <Search className="size-4 text-content-tertiary" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('bankCancelled.search')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
        <div className="flex h-10 items-center gap-1 rounded-xl bg-surface-sunken p-1 ring-1 ring-border-subtle">
          {(['all', 'deal', 'request'] as const).map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={kind === entry}
              onClick={() => setKind(entry)}
              className={cn(
                'h-8 rounded-lg px-3 text-xs font-bold transition-colors',
                kind === entry ? 'bg-surface text-content shadow-sm' : 'text-content-tertiary hover:text-content-secondary',
              )}
            >
              {t(`bankCancelled.kind.${entry}`)}
              {entry !== 'all' && rows && <span className="ms-1 tabular-nums text-content-tertiary">{count(entry)}</span>}
            </button>
          ))}
        </div>
        {people.length > 0 && (
          <select
            value={who}
            onChange={(event) => setWho(event.target.value)}
            className="h-10 rounded-xl bg-surface-sunken px-3 text-sm font-semibold text-content ring-1 ring-border-subtle"
          >
            <option value="">{t('bankCancelled.everyone')}</option>
            {people.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
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

      {rows === null ? (
        <div className="space-y-2 p-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : shown.length === 0 ? (
        <div className="p-8">
          <EmptyState title={t('bankCancelled.none')} description={t('bankCancelled.noneHint')} />
        </div>
      ) : (
        <ul className="divide-y divide-border-subtle">
          {shown.map((row) => (
            <li
              key={row.key}
              className="grid items-center gap-x-4 gap-y-1.5 px-3 py-2.5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)]"
            >
              {/* What it was. */}
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    'inline-flex size-9 shrink-0 items-center justify-center rounded-lg',
                    row.kind === 'deal' ? 'bg-danger-subtle text-danger-text' : 'bg-warning-subtle text-warning-text',
                  )}
                >
                  {row.kind === 'deal' ? <Undo2 className="size-4" /> : <MessageSquareX className="size-4" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-content">{row.name ?? '—'}</span>
                  <span className="block truncate text-[11px] text-content-tertiary">
                    {t(`bankCancelled.kind.${row.kind}`)}
                    {row.channel && ` · ${row.channel}`}
                    {row.account && (
                      <>
                        {' · '}
                        <span className="ltr-content tabular-nums">{row.account}</span>
                      </>
                    )}
                    {row.group && ` · ${row.group}`}
                  </span>
                </span>
              </span>

              {/* The sum, and its reference. */}
              <span className="min-w-0">
                <span className="ltr-content block font-semibold tabular-nums text-content">
                  <Money value={row.amount} currency={row.currency} />
                </span>
                <span className="block truncate text-[10px] text-content-tertiary">
                  {row.reference && <span className="ltr-content font-mono">{row.reference}</span>}
                  {row.reference && ' · '}
                  {t('bankCancelled.made', { at: stamp(row.madeAt) })}
                </span>
              </span>

              {/* Who cancelled it, when, and why. */}
              <span className="min-w-0 space-y-0.5">
                <span className="flex flex-wrap items-center gap-x-2 text-xs">
                  <span className="inline-flex items-center gap-1 font-bold text-content">
                    <UserRound className="size-3.5 text-content-tertiary" />
                    {byName(row) ?? t('bankCancelled.unknownBy')}
                  </span>
                  {row.cancelledAt && (
                    <span className="tabular-nums text-content-tertiary">{stamp(row.cancelledAt)}</span>
                  )}
                  {row.wasSent && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">
                      <Ban className="size-3" />
                      {t('bankCancelled.wasSent')}
                    </span>
                  )}
                </span>
                {row.reason && (
                  <span className="block truncate text-[11px] text-content-secondary">
                    {t('bankCancelled.reason')}: {row.reason}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
