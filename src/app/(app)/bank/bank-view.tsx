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
    <div className="space-y-4">
      {/* --- Each account, and what waits on it --- */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={channel === null}
          onClick={() => setChannel(null)}
          className={cn(
            'h-10 rounded-full px-4 text-sm font-semibold transition-colors',
            channel === null ? 'bg-primary text-white' : 'bg-surface text-content-secondary ring-1 ring-border-subtle',
          )}
        >
          {t('bank.all')} · {desk.waiting.length}
        </button>
        {channels.map(([name, entry]) => (
          <button
            key={name}
            type="button"
            aria-pressed={channel === name}
            onClick={() => setChannel(channel === name ? null : name)}
            className={cn(
              'h-10 rounded-full px-4 text-sm font-semibold transition-colors',
              channel === name ? 'bg-primary text-white' : 'bg-surface text-content-secondary ring-1 ring-border-subtle',
            )}
          >
            {name} · {entry.count}
            <span className="ms-2 text-xs font-normal opacity-80">
              {[...entry.sums.entries()].map(([currency, sum]) => (
                <Money key={currency} value={sum} currency={currency} className="ms-1" />
              ))}
            </span>
          </button>
        ))}
        <Button variant="ghost" size="sm" icon={<RefreshCw />} onClick={() => void load()} className="ms-auto">
          {t('bank.refresh')}
        </Button>
      </div>

      {/* --- What is still to be sent --- */}
      {shown.length === 0 ? (
        <EmptyState icon={<CheckCircle2 />} title={t('bank.emptyTitle')} description={t('bank.emptyBody')} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {shown.map((line) => (
            <Card key={line.id} className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-primary-text">
                    <Landmark className="size-4 shrink-0" />
                    {line.channel ?? t('bank.noChannel')}
                  </p>
                  <p className="mt-0.5 text-xs text-content-tertiary">
                    {line.kind} · <span className="ltr-content font-mono">{line.reference}</span> ·{' '}
                    <DateText value={line.at} withTime />
                    {line.by && <> · {line.by}</>}
                  </p>
                </div>
                <div className="text-end">
                  <Money value={line.amount} currency={line.currency} className="text-2xl font-bold text-content" />
                  <div>
                    <CopyValue value={plainFigure(line.amount)} label={t('bank.amount')} />
                  </div>
                </div>
              </div>

              <dl className="grid gap-1 rounded-xl bg-surface-sunken p-2 text-sm">
                {line.account && (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-xs text-content-tertiary">{t('bank.account')}</dt>
                    <dd>
                      <CopyValue value={line.account} label={t('bank.account')} big />
                    </dd>
                  </div>
                )}
                {line.name && (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-xs text-content-tertiary">{t('bank.name')}</dt>
                    <dd>
                      <CopyValue value={line.name} label={t('bank.name')} />
                    </dd>
                  </div>
                )}
                {line.phone && line.phone !== line.account && (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="text-xs text-content-tertiary">{t('bank.phone')}</dt>
                    <dd>
                      <CopyValue value={line.phone} label={t('bank.phone')} />
                    </dd>
                  </div>
                )}
              </dl>
              {line.notes && <p className="text-xs text-content-secondary">{line.notes}</p>}

              <Button
                variant="primary"
                fullWidth
                icon={<Check />}
                onClick={() => {
                  setReceipt(null);
                  setSending(line);
                }}
              >
                {t('bank.markSent')}
              </Button>
            </Card>
          ))}
        </div>
      )}

      {/* --- Sent today --- */}
      {desk.sent.length > 0 && (
        <Card className="p-4">
          <p className="mb-2 text-sm font-semibold text-content">
            {t('bank.sentToday')} · {desk.sent.length}
          </p>
          <ul className="divide-y divide-border-subtle">
            {desk.sent.map((line) => (
              <li key={line.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  <CheckCircle2 className="me-1 inline size-4 text-success-text" />
                  {line.name ?? line.account} · {line.channel}
                  <span className="ms-1 text-xs text-content-tertiary">
                    {line.sentAt && <DateText value={line.sentAt} withTime />}
                    {line.sentBy && <> · {line.sentBy}</>}
                  </span>
                </span>
                <Money value={line.amount} currency={line.currency} className="shrink-0 font-semibold" />
              </li>
            ))}
          </ul>
        </Card>
      )}

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
    </div>
  );
}

/** A stored amount (scaled by 1e8) as the bank's app takes it: "320", "12.5". */
function plainFigure(scaled: string): string {
  const digits = scaled.replace(/^-/, '').padStart(9, '0');
  const whole = digits.slice(0, -8).replace(/^0+(?=\d)/, '');
  const fraction = digits.slice(-8).replace(/0+$/, '').slice(0, 2);
  return fraction ? `${whole}.${fraction}` : whole;
}
