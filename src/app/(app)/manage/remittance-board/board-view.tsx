'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  BadgeCheck,
  Building2,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileImage,
  Hourglass,
  ListChecks,
  MessageSquareReply,
  RefreshCw,
  Search,
  Send,
  Timer,
  UserCheck,
  X,
  XCircle,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { useToast } from '@/ui/overlay';
import { Card, EmptyState, Skeleton } from '@/ui/primitives';
import { Input } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { DateRangePicker, keyOf as dayOf, type DayRange } from '@/ui/date-range-picker';
import { cn } from '@/ui/utils';
import { networkLabel } from '../inbox/notice-panel';
import { PartsBar } from '../../bank/parts';

type Stage = 'received' | 'sent' | 'answered' | 'decided' | 'remitted' | 'paid' | 'told';
type State = 'new' | 'checking' | 'confirmed' | 'remitted' | 'done' | 'rejected';

interface Line {
  id: string;
  chatId: string;
  imageId: string | null;
  direction: 'IN' | 'OUT';
  beneficiaryName: string | null;
  deliverAmount: string | null;
  deliverCurrency: string | null;
  owner: { id: string; nameAr: string; nameEn: string };
  mine: boolean;
  customerName: string | null;
  customerPhone: string | null;
  network: string;
  amount: string | null;
  currency: string | null;
  agentName: string | null;
  note: string | null;
  state: State;
  waited: number | null;
  late: 'ok' | 'late' | 'veryLate';
  deal: {
    id: string;
    reference: string;
    fromAmount: string;
    fromCurrency: string;
    toAmount: string;
    toCurrency: string;
    bank: boolean;
    /** Its transfer paid in part: what was sent, and what is left. */
    parts?: { total: string; paid: string; remaining: string; currency: string; closed?: boolean } | null;
    channel: string | null;
    account: string | null;
  } | null;
  stages: Partial<Record<Stage, { at: string; by?: string | null; note?: string | null }>>;
  createdAt: string;
}

interface Board {
  lines: Line[];
  summary: {
    total: number;
    incoming: number;
    outgoing: number;
    new: number;
    checking: number;
    confirmed: number;
    remitted: number;
    done: number;
    rejected: number;
    late: number;
    avgAnswer: number | null;
    avgDone: number | null;
  };
  owners: { id: string; nameAr: string; nameEn: string }[];
}

const STAGES: Stage[] = ['received', 'sent', 'answered', 'decided', 'remitted', 'paid', 'told'];

const STATE_STYLE: Record<State, string> = {
  new: 'bg-surface-sunken text-content-secondary',
  checking: 'bg-warning-subtle text-warning-text',
  confirmed: 'bg-primary-subtle text-primary-text',
  remitted: 'bg-[#e0e7ff] text-[#3730a3] dark:bg-[#312e81]/50 dark:text-[#c7d2fe]',
  done: 'bg-success-subtle text-success-text',
  rejected: 'bg-danger-subtle text-danger-text',
};

const STAGE_ICON: Record<Stage, ReactNode> = {
  received: <FileImage className="size-3.5" />,
  sent: <Send className="size-3.5" />,
  answered: <MessageSquareReply className="size-3.5" />,
  decided: <BadgeCheck className="size-3.5" />,
  remitted: <ListChecks className="size-3.5" />,
  paid: <Building2 className="size-3.5" />,
  told: <UserCheck className="size-3.5" />,
};

const today = (): DayRange => {
  const key = dayOf(new Date());
  return { from: key, to: key };
};

const clock = (value: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

/** Minutes as the desk says them: 12 د, 2 س 5 د, 3 ي. */
function waitedText(minutes: number, t: ReturnType<typeof useLocale>['t']): string {
  if (minutes < 60) return t('remitBoard.min', { n: minutes });
  if (minutes < 24 * 60) return t('remitBoard.hours', { h: Math.floor(minutes / 60), m: minutes % 60 });
  return t('remitBoard.days', { d: Math.floor(minutes / (24 * 60)) });
}

/**
 * The remittances taken from WhatsApp, as the bank desk shows transfers: the
 * figures across the top, a row each with its track from notice to money
 * paid, the step it waits on coloured by how long, and the whole of it beside.
 */
export function BoardView({ everyone }: { everyone: boolean }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [board, setBoard] = useState<Board | null>(null);
  const [days, setDays] = useState<DayRange>(today);
  const [owner, setOwner] = useState('');
  const [show, setShow] = useState<'all' | State | 'late'>('all');
  const [way, setWay] = useState<'all' | 'IN' | 'OUT'>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const edge = (key: string, end: boolean) => {
        const [year, month, day] = key.split('-').map(Number) as [number, number, number];
        return (end ? new Date(year, month - 1, day, 23, 59, 59, 999) : new Date(year, month - 1, day)).toISOString();
      };
      const params = new URLSearchParams({
        ...(days.from ? { from: edge(days.from, false) } : { from: new Date(2000, 0, 1).toISOString() }),
        ...(days.to ? { to: edge(days.to, true) } : {}),
        ...(owner ? { owner } : {}),
      });
      setBoard(await api.get<Board>(`/api/inbox/board?${params.toString()}`));
    } catch (cause) {
      toast.error(t('errors.title'), cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'));
      setBoard((current) => current ?? null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, owner]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const words = query.trim();
  const digits = words.replace(/\D/g, '');
  const rows = useMemo(
    () =>
      (board?.lines ?? [])
        .filter((line) => way === 'all' || line.direction === way)
        .filter((line) =>
          show === 'all'
            ? true
            : show === 'late'
              ? line.late !== 'ok' && line.state !== 'done' && line.state !== 'rejected'
              : line.state === show,
        )
        .filter((line) => {
          if (!words) return true;
          if ((line.customerName ?? '').includes(words) || (line.beneficiaryName ?? '').includes(words) || (line.deal?.reference ?? '').includes(words.toUpperCase())) return true;
          return Boolean(digits) && ((line.customerPhone ?? '').includes(digits) || (line.deal?.account ?? '').includes(digits));
        })
        // What still waits first, the longest waiting on top; then the finished, newest first.
        .sort((a, b) => {
          const openA = a.state !== 'done' && a.state !== 'rejected';
          const openB = b.state !== 'done' && b.state !== 'rejected';
          if (openA !== openB) return openA ? -1 : 1;
          return openA ? (b.waited ?? 0) - (a.waited ?? 0) : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }),
    [board, show, way, words, digits],
  );
  const opened = board?.lines.find((line) => line.id === open) ?? null;
  /** The customer told with the receipt, by hand, for a remittance sent before it was done by itself. */
  const [telling, setTelling] = useState(false);
  const tell = async (id: string) => {
    setTelling(true);
    try {
      await api.post('/api/inbox/board', { action: 'tell', id });
      toast.success(t('remitBoard.told'));
      void load();
    } catch (cause) {
      toast.error(t('errors.title'), cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'));
    } finally {
      setTelling(false);
    }
  };
  // Each step in the words of its way: sent out, the agent carries it out rather than checks it.
  const stageWord = (line: Line, stage: Stage | 'rejected') =>
    line.direction === 'OUT' ? t(`remitBoard.stageOut.${stage}`) : t(`remitBoard.stage.${stage}`);
  const summary = board?.summary;

  const card = (key: 'all' | State | 'late', label: string, value: number, icon: ReactNode, tone: string) => (
    <button
      key={key}
      type="button"
      aria-pressed={show === key}
      onClick={() => setShow((current) => (current === key && key !== 'all' ? 'all' : key))}
      className={cn(
        'flex items-center gap-3 rounded-2xl bg-surface p-3 text-start ring-1 transition-shadow',
        show === key ? 'ring-2 ring-primary shadow-sm' : 'ring-border-subtle hover:shadow-sm',
      )}
    >
      <span className={cn('inline-flex size-10 shrink-0 items-center justify-center rounded-xl', tone)}>{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-content-tertiary">{label}</span>
        <span className="block text-xl font-extrabold tabular-nums text-content">{value}</span>
      </span>
    </button>
  );

  return (
    <div className="space-y-4">
      {/* The figures across the top: each a filter. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        {card('all', t('remitBoard.show.all'), summary?.total ?? 0, <ListChecks className="size-5" />, 'bg-surface-sunken text-content-secondary')}
        {card('checking', t('remitBoard.show.checking'), summary?.checking ?? 0, <Hourglass className="size-5" />, 'bg-warning-subtle text-warning-text')}
        {card('confirmed', t('remitBoard.show.confirmed'), summary?.confirmed ?? 0, <BadgeCheck className="size-5" />, 'bg-primary-subtle text-primary-text')}
        {card('remitted', t('remitBoard.show.remitted'), summary?.remitted ?? 0, <Building2 className="size-5" />, STATE_STYLE.remitted)}
        {card('done', t('remitBoard.show.done'), summary?.done ?? 0, <CheckCircle2 className="size-5" />, 'bg-success-subtle text-success-text')}
        {card('rejected', t('remitBoard.show.rejected'), summary?.rejected ?? 0, <XCircle className="size-5" />, 'bg-danger-subtle text-danger-text')}
        {card('late', t('remitBoard.show.late'), summary?.late ?? 0, <AlertTriangle className="size-5" />, 'bg-danger-subtle text-danger-text')}
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle p-3">
          <div className="min-w-[12rem] flex-1">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('remitBoard.search')}
              iconStart={<Search className="size-4" />}
            />
          </div>
          <div className="flex h-10 items-center gap-1 rounded-xl bg-surface-sunken p-1 ring-1 ring-border-subtle">
            {(['all', 'IN', 'OUT'] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                aria-pressed={way === entry}
                onClick={() => setWay(entry)}
                className={cn(
                  'h-8 rounded-lg px-3 text-xs font-bold transition-colors',
                  way === entry ? 'bg-surface text-content shadow-sm' : 'text-content-tertiary hover:text-content-secondary',
                )}
              >
                {t(`remitBoard.way.${entry}`)}
                {entry !== 'all' && summary && (
                  <span className="ms-1 tabular-nums text-content-tertiary">
                    {entry === 'IN' ? summary.incoming : summary.outgoing}
                  </span>
                )}
              </button>
            ))}
          </div>
          <DateRangePicker value={days} onChange={setDays} className="h-10" />
          {everyone && (
            <select
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              className="h-10 rounded-xl bg-surface-sunken px-3 text-sm font-semibold text-content ring-1 ring-border-subtle"
            >
              <option value="">{t('remitBoard.allTellers')}</option>
              {(board?.owners ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {locale === 'ar' ? entry.nameAr : entry.nameEn}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={() => void load()}
            aria-label={t('common.refresh')}
            className="inline-flex size-10 items-center justify-center rounded-xl text-content-tertiary ring-1 ring-border-subtle hover:bg-surface-sunken"
          >
            <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          </button>
          {summary && (summary.avgAnswer !== null || summary.avgDone !== null) && (
            <p className="flex w-full flex-wrap gap-x-4 gap-y-1 text-[11px] font-semibold text-content-tertiary">
              {summary.avgAnswer !== null && (
                <span className="inline-flex items-center gap-1">
                  <Timer className="size-3" />
                  {t('remitBoard.avgAnswer', { n: summary.avgAnswer })}
                </span>
              )}
              {summary.avgDone !== null && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" />
                  {t('remitBoard.avgDone', { n: summary.avgDone })}
                </span>
              )}
            </p>
          )}
        </div>

        {!board ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8">
            <EmptyState title={t('remitBoard.empty')} description={t('remitBoard.emptyHint')} />
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {rows.map((line) => (
              <li key={line.id}>
                <button
                  type="button"
                  onClick={() => setOpen(line.id)}
                  className={cn(
                    'grid w-full items-center gap-x-3 gap-y-2 border-s-4 px-3 py-2.5 text-start transition-colors hover:bg-surface-sunken/60 md:grid-cols-[4.5rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.6fr)_7rem]',
                    line.state === 'done' || line.state === 'rejected'
                      ? 'border-s-transparent'
                      : line.late === 'veryLate'
                        ? 'border-s-danger'
                        : line.late === 'late'
                          ? 'border-s-warning'
                          : 'border-s-transparent',
                    open === line.id && 'bg-primary-subtle/40',
                  )}
                >
                  <span className="hidden text-sm font-semibold tabular-nums text-content md:block">{clock(line.createdAt)}</span>
                  <span className="flex min-w-0 items-center gap-2.5">
                    {line.imageId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/inbox/images/${line.imageId}`}
                        alt=""
                        loading="lazy"
                        className="size-10 shrink-0 rounded-lg bg-surface-sunken object-cover ring-1 ring-border-subtle"
                      />
                    ) : (
                      <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-base ring-1 ring-border-subtle">
                        {line.direction === 'OUT' ? '📤' : '📥'}
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold text-content">
                        {line.customerName ?? (line.customerPhone ? `+${line.customerPhone}` : '—')}
                      </span>
                      <span className="block truncate text-[11px] text-content-tertiary">
                        <span
                          className={cn(
                            'me-1 rounded px-1 text-[10px] font-bold',
                            line.direction === 'OUT' ? 'bg-primary-subtle text-primary-text' : 'bg-success-subtle text-success-text',
                          )}
                        >
                          {t(line.direction === 'OUT' ? 'inbox.out.short' : 'inbox.out.inShort')}
                        </span>
                        {networkLabel(t, line.network)}
                        {line.direction === 'OUT' && line.beneficiaryName && ` → ${line.beneficiaryName}`}
                        {everyone && ` · ${locale === 'ar' ? line.owner.nameAr : line.owner.nameEn}`}
                        <span className="md:hidden"> · {clock(line.createdAt)}</span>
                      </span>
                    </span>
                  </span>
                  <span className="min-w-0 text-sm">
                    {line.deal ? (
                      <span className="ltr-content flex flex-wrap items-baseline gap-x-1 font-semibold tabular-nums text-content">
                        <Money value={line.deal.fromAmount} currency={line.deal.fromCurrency} />
                        <span className="text-content-tertiary">→</span>
                        {/* Sent out: what reaches the beneficiary, not what the agent is owed. */}
                        {line.direction === 'OUT' && line.deliverAmount ? (
                          <Money value={line.deliverAmount} currency={line.deliverCurrency ?? ''} />
                        ) : (
                          <Money value={line.deal.toAmount} currency={line.deal.toCurrency} />
                        )}
                      </span>
                    ) : line.direction === 'OUT' && line.deliverAmount ? (
                      <span className="ltr-content font-semibold tabular-nums text-content">
                        <Money value={line.deliverAmount} currency={line.deliverCurrency ?? ''} />
                      </span>
                    ) : line.amount ? (
                      <span className="ltr-content font-semibold tabular-nums text-content">
                        <Money value={line.amount} currency={line.currency ?? ''} />
                      </span>
                    ) : (
                      <span className="text-xs text-content-tertiary">—</span>
                    )}
                    {line.deal && (
                      <span className="ltr-content block truncate font-mono text-[10px] text-content-tertiary">{line.deal.reference}</span>
                    )}
                    {line.deal?.parts && (
                      <PartsBar
                        amount={line.deal.parts.total}
                        paid={line.deal.parts.paid}
                        currency={line.deal.parts.currency}
                        closed={line.deal.parts.closed}
                        className="mt-1 max-w-[10rem]"
                      />
                    )}
                  </span>
                  {/* The track: each step lit once it is done, the one it waits on pulsing. */}
                  <span className="flex items-center" aria-label={t(`remitBoard.state.${line.state}`)}>
                    {STAGES.map((stage, index) => {
                      const done = Boolean(line.stages[stage]);
                      const next = !done && (index === 0 || Boolean(line.stages[STAGES[index - 1]!]));
                      const stopped = line.state === 'rejected' && !done;
                      return (
                        <span key={stage} className="flex flex-1 items-center last:flex-none">
                          <span
                            title={`${stageWord(line, stage)}${done ? ` · ${clock(line.stages[stage]!.at)}` : ''}`}
                            className={cn(
                              'inline-flex size-6 shrink-0 items-center justify-center rounded-full',
                              done
                                ? stage === 'decided' && line.state === 'rejected'
                                  ? 'bg-danger text-white'
                                  : 'bg-success text-white'
                                : stopped
                                  ? 'bg-surface-sunken text-content-tertiary/40'
                                  : next
                                    ? cn(
                                        'ring-2',
                                        line.late === 'veryLate'
                                          ? 'animate-pulse bg-danger-subtle text-danger-text ring-danger'
                                          : line.late === 'late'
                                            ? 'animate-pulse bg-warning-subtle text-warning-text ring-warning'
                                            : 'bg-primary-subtle text-primary-text ring-primary',
                                      )
                                    : 'bg-surface-sunken text-content-tertiary',
                            )}
                          >
                            {STAGE_ICON[stage]}
                          </span>
                          {index < STAGES.length - 1 && (
                            <span className={cn('h-0.5 flex-1', line.stages[STAGES[index + 1]!] ? 'bg-success' : 'bg-border-subtle')} />
                          )}
                        </span>
                      );
                    })}
                  </span>
                  <span className="flex items-center justify-between gap-2 md:flex-col md:items-end">
                    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-bold', STATE_STYLE[line.state])}>
                      {t(`remitBoard.state.${line.state}`)}
                    </span>
                    {line.waited !== null && line.state !== 'done' && line.state !== 'rejected' && (
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 text-[11px] font-semibold tabular-nums',
                          line.late === 'veryLate' ? 'text-danger-text' : line.late === 'late' ? 'text-warning-text' : 'text-content-tertiary',
                        )}
                      >
                        <Clock className="size-3" />
                        {waitedText(line.waited, t)}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* The whole of one, beside the list. */}
      {opened && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
          <button type="button" aria-label={t('common.close')} onClick={() => setOpen(null)} className="absolute inset-0 bg-black/30 backdrop-blur-[1px]" />
          <div className="relative flex h-full w-full max-w-md flex-col bg-surface-sunken shadow-[var(--shadow-lg)]">
            <div className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-content">
                  {opened.customerName ?? (opened.customerPhone ? `+${opened.customerPhone}` : '—')}
                </span>
                <span className="block text-[11px] text-content-tertiary">
                  {t(opened.direction === 'OUT' ? 'inbox.out.short' : 'inbox.out.inShort')} · {networkLabel(t, opened.network)}
                  {opened.beneficiaryName && ` → ${opened.beneficiaryName}`} · {locale === 'ar' ? opened.owner.nameAr : opened.owner.nameEn}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setOpen(null)}
                aria-label={t('common.close')}
                className="inline-flex size-9 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              {opened.imageId && (
                <a href={`/api/inbox/images/${opened.imageId}`} target="_blank" rel="noopener noreferrer" className="block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/inbox/images/${opened.imageId}`} alt="" className="max-h-64 w-full rounded-xl bg-surface object-contain ring-1 ring-border-subtle" />
                </a>
              )}

              {opened.deal && (
                <div className="space-y-1 rounded-xl bg-surface p-3 text-sm ring-1 ring-border-subtle">
                  <p className="ltr-content flex flex-wrap items-baseline gap-x-1 font-bold tabular-nums text-content">
                    <Money value={opened.deal.fromAmount} currency={opened.deal.fromCurrency} />
                    <span className="text-content-tertiary">→</span>
                    <Money value={opened.deal.toAmount} currency={opened.deal.toCurrency} />
                  </p>
                  <p className="text-xs text-content-secondary">
                    {opened.deal.bank
                      ? `${opened.deal.channel ?? ''}${opened.deal.account ? ` · ${opened.deal.account}` : ''}`
                      : t('inbox.remit.cash')}
                  </p>
                  <Link href={`/manage/transactions/${opened.deal.id}`} className="ltr-content inline-flex items-center gap-1 font-mono text-xs text-primary-text hover:underline">
                    {opened.deal.reference}
                    <ExternalLink className="size-3" />
                  </Link>
                </div>
              )}

              {/* Every step, when and by whom. */}
              <ol className="space-y-0 rounded-xl bg-surface p-3 ring-1 ring-border-subtle">
                {STAGES.map((stage, index) => {
                  const done = opened.stages[stage];
                  const before = index > 0 ? opened.stages[STAGES[index - 1]!] : undefined;
                  const took = done && before ? Math.round((new Date(done.at).getTime() - new Date(before.at).getTime()) / 60_000) : null;
                  return (
                    <li key={stage} className="relative flex gap-3 pb-4 last:pb-0">
                      {index < STAGES.length - 1 && (
                        <span className={cn('absolute start-3 top-7 h-[calc(100%-1.5rem)] w-0.5', opened.stages[STAGES[index + 1]!] ? 'bg-success' : 'bg-border-subtle')} />
                      )}
                      <span
                        className={cn(
                          'relative inline-flex size-6 shrink-0 items-center justify-center rounded-full',
                          done
                            ? stage === 'decided' && opened.state === 'rejected'
                              ? 'bg-danger text-white'
                              : 'bg-success text-white'
                            : 'bg-surface-sunken text-content-tertiary',
                        )}
                      >
                        {STAGE_ICON[stage]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className={cn('text-sm font-semibold', done ? 'text-content' : 'text-content-tertiary')}>
                            {stage === 'decided' && opened.state === 'rejected' ? stageWord(opened, 'rejected') : stageWord(opened, stage)}
                          </span>
                          {done && (
                            <span className="shrink-0 text-[11px] tabular-nums text-content-tertiary">
                              <DateText value={done.at} withTime />
                            </span>
                          )}
                        </span>
                        {done?.by && <span className="block text-xs text-content-secondary">{done.by}</span>}
                        {done?.note && <span className="mt-0.5 block whitespace-pre-wrap rounded-md bg-surface-sunken px-2 py-1 text-xs text-content-secondary">{done.note}</span>}
                        {took !== null && took > 0 && (
                          <span className="text-[10px] text-content-tertiary">+{waitedText(took, t)}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>

              {/* Sent to their bank, and not told yet: the receipt sent to them now. */}
              {opened.stages.paid && !opened.stages.told && opened.deal?.bank && (
                <button
                  type="button"
                  disabled={telling}
                  onClick={() => void tell(opened.id)}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-success px-3 py-2.5 text-sm font-semibold text-white hover:bg-success/90 disabled:opacity-60"
                >
                  <Send className="size-4" />
                  {telling ? t('remitBoard.telling') : t('remitBoard.tell')}
                </button>
              )}
              {opened.mine && (
                <Link
                  href={`/manage/inbox?notice=${encodeURIComponent(opened.id)}&chat=${encodeURIComponent(opened.chatId)}`}
                  className="flex items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm font-semibold text-content-inverse hover:bg-primary-hover"
                >
                  <MessageSquareReply className="size-4" />
                  {t('remitBoard.openChat')}
                </Link>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
