'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, CheckCircle2, Copy, Landmark, RefreshCw } from 'lucide-react';
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
  reference: string;
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
}

interface Desk {
  waiting: Line[];
  sent: Line[];
}

/** A value with a button that puts it on the clipboard, for pasting into the bank's app. */
function CopyValue({ value, label, big }: { value: string; label: string; big?: boolean }) {
  const { t } = useLocale();
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => {
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
  const { t } = useLocale();
  const toast = useToast();
  const [desk, setDesk] = useState<Desk | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [sending, setSending] = useState<Line | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDesk(await api.get<Desk>('/api/bank'));
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      );
      setDesk((current) => current ?? { waiting: [], sent: [] });
    }
  }, [toast, t]);

  useEffect(() => {
    void load();
    // New deals keep arriving at the counter; a desk nobody is looking at asks nothing.
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  // What is waiting on each account, so the desk can work one bank at a time.
  const channels = useMemo(() => {
    const totals = new Map<string, { count: number; sums: Map<string, bigint> }>();
    for (const line of desk?.waiting ?? []) {
      const key = line.channel ?? '—';
      const entry = totals.get(key) ?? { count: 0, sums: new Map() };
      entry.count += 1;
      entry.sums.set(line.currency, (entry.sums.get(line.currency) ?? 0n) + BigInt(line.amount));
      totals.set(key, entry);
    }
    return [...totals.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [desk]);

  const shown = (desk?.waiting ?? []).filter((line) => !channel || (line.channel ?? '—') === channel);

  const markSent = async () => {
    if (!sending) return;
    setBusy(true);
    try {
      await api.post(`/api/bank/${sending.id}`, { receipt });
      toast.success(t('bank.sentDone'), sending.reference);
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
            {t('bank.waiting')} · <span className="tabular-nums">{desk.waiting.length}</span>
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
            { key: null as string | null, label: t('bank.all'), count: desk.waiting.length },
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
          <ul className="divide-y divide-border-subtle">
            {shown.map((line) => (
              <li key={line.id} className="space-y-1.5 px-3 py-2.5 transition-colors hover:bg-surface-sunken">
                <div className="flex items-center gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1 truncate rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] font-semibold text-primary-text">
                    <Landmark className="size-3 shrink-0" />
                    {line.channel ?? t('bank.noChannel')}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(plainFigure(line.amount));
                      toast.success(t('bank.copied'), t('bank.amount'));
                    }}
                    title={t('bank.amount')}
                    className="ms-auto"
                  >
                    <Money value={line.amount} currency={line.currency} className="text-base font-bold text-content" />
                  </button>
                  <Button
                    size="sm"
                    variant="primary"
                    icon={<Check />}
                    onClick={() => {
                      setReceipt(null);
                      setSending(line);
                    }}
                  >
                    {t('bank.markSentShort')}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-x-1">
                  {line.account && <CopyValue value={line.account} label={t('bank.account')} big />}
                  {line.name && <CopyValue value={line.name} label={t('bank.name')} />}
                  {line.phone && line.phone !== line.account && (
                    <CopyValue value={line.phone} label={t('bank.phone')} />
                  )}
                </div>
                <p className="truncate text-[11px] text-content-tertiary">
                  {line.kind} · <span className="ltr-content font-mono">{line.reference}</span> ·{' '}
                  <DateText value={line.at} withTime />
                  {line.by && <> · {line.by}</>}
                  {line.notes && <> · {line.notes}</>}
                </p>
              </li>
            ))}
          </ul>
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

/** A stored amount (scaled by 1e8) as the bank's app takes it: "320", "12.5". */
function plainFigure(scaled: string): string {
  const digits = scaled.replace(/^-/, '').padStart(9, '0');
  const whole = digits.slice(0, -8).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-8).replace(/0+$/, '').slice(0, 2);
  return fraction ? `${whole}.${fraction}` : whole;
}
