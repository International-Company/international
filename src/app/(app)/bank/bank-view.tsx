'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock,
  Coins,
  Copy,
  CornerUpRight,
  Landmark,
  Layers,
  MessagesSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { clockOf, dayKey, dayLabel } from './days';
import { ANY_DAY, DateRangePicker, inRange, type DayRange } from '@/ui/date-range-picker';
import { PillSelect } from '@/ui/pill-select';
import { TransferDetail } from './transfer-detail';
import { MessageTrace } from './message-trace';
import { ForwardDialog } from './forward-dialog';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { DateText, Money } from '@/ui/display';
import { PhotoField } from '@/ui/photo-field';
import { cn } from '@/ui/utils';

interface Line {
  id: string;
  /** A deal's transfer, or one asked for in a followed group. */
  source?: 'deal' | 'group';
  reference: string;
  /** PENDING_TRANSFER while it waits; POSTED once sent; REVERSED when the deal was cancelled. */
  status: string;
  kind: string;
  at: string;
  channel: string | null;
  account: string | null;
  name: string | null;
  phone: string | null;
  amount: string;
  currency: string;
  notes: string | null;
  by: string | null;
  sentAt: string | null;
  sentBy: string | null;
  /** Its message in the bank group, as the groups' panel kept it: to check and pass on. */
  messageId?: string | null;
}

interface Desk {
  /** The bank transfers group the list is drawn from; none set, every transfer. */
  group?: { id: string; name: string } | null;
  waiting: Line[];
  sent: Line[];
  /** Every transfer of the days asked for, sent or not. */
  range?: Line[] | null;
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

/**
 * The bank desk.
 *
 * Each transfer a deal promised, oldest first, laid out the way the bank's app
 * asks for it: where, the account, the name, the sum — each copied with a tap.
 * Sent, it is marked with the bank's receipt, and the group is told.
 */
export function BankView() {
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
  /** The transfer open in full beside the list. */
  const [opened, setOpened] = useState<string | null>(null);
  const [sending, setSending] = useState<Line | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A transfer's message followed through the groups, or being passed on to those that carry it out. */
  const [tracing, setTracing] = useState<string | null>(null);
  const [forwarding, setForwarding] = useState<string | null>(null);

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
  }, [toast, t, days]);

  useEffect(() => {
    void load();
    // New deals keep arriving at the counter; a desk nobody is looking at asks nothing.
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  // The days chosen bring every transfer in them, sent or not; otherwise what still waits.
  const source = (desk?.range ?? desk?.waiting ?? []) as Line[];

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
  }, [desk]);

  // What the list can be narrowed by: the money and the kinds actually waiting.
  const currencies = [...new Set((source).map((line) => line.currency))];
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
    const words = [line.name, line.reference, line.channel, line.notes, line.kind]
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
    day.sums.set(line.currency, (day.sums.get(line.currency) ?? 0n) + BigInt(line.amount));
  }
  const narrowed = Boolean(
    needle || currency || kind || channel || minAmount || maxAmount || days.from || days.to,
  );

  const markSent = async () => {
    if (!sending) return;
    setBusy(true);
    try {
      await api.post(
        sending.source === 'group' ? `/api/bank/requests/${sending.id}` : `/api/bank/${sending.id}`,
        { receipt },
      );
      toast.success(t('bank.sentDone'), sending.reference);
      if (opened === sending.id) setOpened(null);
      setSending(null);
      setReceipt(null);
      await load();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!desk) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <Card className="flex h-[78vh] min-h-[28rem] flex-col overflow-hidden p-0">
      {/* --- The list's head: how many, and which account to work --- */}
      <div className="space-y-2 border-b border-border-subtle p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-content">
            {desk.range ? t('bank.ofTheDays') : t('bank.waiting')} ·{' '}
            <span className="tabular-nums">{source.length}</span>
            {desk.group && (
              <span className="ms-2 inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 align-middle text-[11px] font-medium text-content-secondary">
                <MessagesSquare className="size-3" />
                {t('bank.fromBankGroup', { group: desk.group.name })}
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            aria-label={t('bank.refresh')}
            title={t('bank.refresh')}
            className="inline-flex size-8 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
          >
            <RefreshCw className="size-4" />
          </button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {[
            { key: null as string | null, label: t('bank.all'), count: source.length },
            ...channels.map(([name, entry]) => ({ key: name, label: name, count: entry.count })),
          ].map((chip) => (
            <button
              key={chip.key ?? 'all'}
              type="button"
              aria-pressed={channel === chip.key}
              onClick={() => setChannel(channel === chip.key ? null : chip.key)}
              className={cn(
                'h-8 shrink-0 rounded-full px-3 text-xs font-semibold transition-colors',
                channel === chip.key
                  ? 'bg-primary text-white'
                  : 'bg-surface-sunken text-content-secondary hover:text-content',
              )}
            >
              {chip.label} · <span className="tabular-nums">{chip.count}</span>
            </button>
          ))}
        </div>
        {/* Search, then the money and the kind, and which end of the list first. */}
        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-content-tertiary" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('bank.search')}
            className="h-9 w-full rounded-full bg-surface-sunken ps-8 pe-3 text-sm text-content outline-none ring-1 ring-transparent focus:ring-primary"
          />
        </div>
        {/* Which days, on a calendar. */}
        <DateRangePicker value={days} onChange={setDays} />
        <div className="flex flex-wrap items-center gap-1.5">
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
                hint: (source).filter((line) => line.currency === code).length,
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
                hint: (source).filter((line) => line.kind === name).length,
              }))}
            />
          )}
          {/* The sum, from and to. */}
          <div className="flex items-center gap-1 rounded-full bg-surface-sunken px-2">
            <span className="text-xs text-content-tertiary">{t('bank.amountRange')}</span>
            <input
              inputMode="decimal"
              dir="ltr"
              value={minAmount}
              onChange={(event) => setMinAmount(digitsOnly(event.target.value))}
              placeholder={t('bank.from')}
              aria-label={t('bank.from')}
              className="h-8 w-16 bg-transparent text-center text-xs font-medium tabular-nums text-content outline-none"
            />
            <span className="text-xs text-content-tertiary">–</span>
            <input
              inputMode="decimal"
              dir="ltr"
              value={maxAmount}
              onChange={(event) => setMaxAmount(digitsOnly(event.target.value))}
              placeholder={t('bank.to')}
              aria-label={t('bank.to')}
              className="h-8 w-16 bg-transparent text-center text-xs font-medium tabular-nums text-content outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => setNewestFirst((value) => !value)}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-surface-sunken px-2.5 text-xs font-medium text-content-secondary hover:text-content"
          >
            <ArrowDownUp className="size-3.5" />
            {newestFirst ? t('bank.newestFirst') : t('bank.oldestFirst')}
          </button>
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
              className="ms-auto inline-flex h-8 items-center gap-1 rounded-full px-2 text-xs text-content-tertiary hover:text-content"
            >
              <X className="size-3.5" />
              {t('bank.clearFilters')} · <span className="tabular-nums">{shown.length}</span>
            </button>
          )}
        </div>
        {channel && (
          <p className="flex flex-wrap gap-2 text-xs text-content-tertiary">
            {[...(channels.find(([name]) => name === channel)?.[1].sums.entries() ?? [])].map(
              ([currency, sum]) => (
                <Money key={currency} value={sum} currency={currency} className="font-semibold" />
              ),
            )}
          </p>
        )}
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
                key={line.id}
                onClick={() => setOpened(line.id)}
                className={cn(
                  'cursor-pointer space-y-1.5 px-3 py-2.5 transition-colors hover:bg-surface-sunken',
                  opened === line.id && 'bg-primary-subtle/60',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1 truncate rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] font-semibold text-primary-text">
                    <Landmark className="size-3 shrink-0" />
                    {line.channel ?? t('bank.noChannel')}
                  </span>
                  {line.source === 'group' && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 text-[11px] font-semibold text-warning-text">
                      <MessagesSquare className="size-3" />
                      {t('bank.fromGroup')}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void navigator.clipboard?.writeText(plainFigure(line.amount));
                      toast.success(t('bank.copied'), t('bank.amount'));
                    }}
                    title={t('bank.amount')}
                    className="ms-auto"
                  >
                    <Money value={line.amount} currency={line.currency} className="text-base font-bold text-content" />
                  </button>
                  {line.status === 'PENDING_TRANSFER' ? (
                    <Button
                      size="sm"
                      variant="primary"
                      icon={<Check />}
                      onClick={(event) => {
                        event.stopPropagation();
                        setReceipt(null);
                        setSending(line);
                      }}
                    >
                      {t('bank.markSentShort')}
                    </Button>
                  ) : (
                    <span
                      className={cn(
                        'inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-semibold',
                        line.status === 'REVERSED'
                          ? 'bg-danger-subtle text-danger-text'
                          : 'bg-success-subtle text-success-text',
                      )}
                    >
                      {line.status === 'REVERSED' ? (
                        t('bankFeed.reversed')
                      ) : (
                        <>
                          <CheckCircle2 className="size-3.5" />
                          {t('bankFeed.sent')}
                        </>
                      )}
                    </span>
                  )}
                </div>
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
                  <span className="truncate">
                    {line.kind} · <span className="ltr-content font-mono">{line.reference}</span>
                    {line.by && <> · {line.by}</>}
                    {line.notes && <> · {line.notes}</>}
                  </span>
                </p>
                {/* Its message in the bank group: where it came from, and on to the groups that carry it out. */}
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!line.messageId}
                    title={line.messageId ? t('bank.verifyHint') : t('bank.noMessage')}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (line.messageId) setTracing(line.messageId);
                    }}
                    className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-sunken px-2.5 text-[11px] font-semibold text-content-secondary transition-colors hover:bg-primary-subtle hover:text-primary-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-sunken disabled:hover:text-content-secondary"
                  >
                    <ShieldCheck className="size-3.5" />
                    {t('bank.verify')}
                  </button>
                  <button
                    type="button"
                    disabled={!line.messageId}
                    title={line.messageId ? t('bank.forwardHint') : t('bank.noMessage')}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (line.messageId) setForwarding(line.messageId);
                    }}
                    className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-sunken px-2.5 text-[11px] font-semibold text-content-secondary transition-colors hover:bg-primary-subtle hover:text-primary-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-sunken disabled:hover:text-content-secondary"
                  >
                    <CornerUpRight className="size-3.5" />
                    {t('bank.forward')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          </section>
          ))
        )}

        {/* --- Sent today, under the list --- */}
        {desk.sent.length > 0 && (
          <details className="border-t border-border-subtle">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-content-secondary">
              {t('bank.sentToday')} · {desk.sent.length}
            </summary>
            <ul className="divide-y divide-border-subtle">
              {desk.sent.map((line) => (
                <li key={line.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                  <span className="min-w-0 truncate">
                    <CheckCircle2 className="me-1 inline size-3.5 text-success-text" />
                    {line.name ?? line.account} · {line.channel}
                    {line.sentBy && <span className="text-content-tertiary"> · {line.sentBy}</span>}
                  </span>
                  <Money value={line.amount} currency={line.currency} className="shrink-0 font-semibold" />
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <MessageTrace id={tracing} onClose={() => setTracing(null)} onOpen={setTracing} />
      <ForwardDialog messageId={forwarding} onClose={() => setForwarding(null)} />

      <TransferDetail
        id={opened}
        fromGroup={source.find((entry) => entry.id === opened)?.source === 'group'}
        onChanged={() => void load()}
        onClose={() => setOpened(null)}
        onSend={(id) => {
          const line = source.find((entry) => entry.id === id);
          if (!line) return;
          // The confirmation takes the screen; the details step aside for it.
          setOpened(null);
          setReceipt(null);
          setSending(line);
        }}
      />

      {/* --- Sent: with the bank's receipt, when there is one --- */}
      <Dialog
        open={sending !== null}
        onClose={() => setSending(null)}
        title={t('bank.markSentTitle')}
        description={
          sending
            ? t('bank.markSentHint', {
                name: sending.name ?? sending.account ?? '',
                channel: sending.channel ?? '',
              })
            : ''
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setSending(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} icon={<Check />} onClick={() => void markSent()}>
              {t('bank.markSentConfirm')}
            </Button>
          </>
        }
      >
        {sending && (
          <div className="space-y-3">
            <p className="text-center">
              <Money value={sending.amount} currency={sending.currency} className="text-2xl font-bold" />
            </p>
            <PhotoField
              label={t('bank.receipt')}
              attach={t('bank.receiptAttach')}
              value={receipt}
              onChange={setReceipt}
            />
          </div>
        )}
      </Dialog>
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

/** A stored amount (scaled by 1e8) as the bank's app takes it: "320", "12.5". */
function plainFigure(scaled: string): string {
  const digits = scaled.replace(/^-/, '').padStart(9, '0');
  const whole = digits.slice(0, -8).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-8).replace(/0+$/, '').slice(0, 2);
  return fraction ? `${whole}.${fraction}` : whole;
}
