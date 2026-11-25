'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ImagePlus, Loader2, Maximize2, Pencil, RefreshCw, Receipt, Trash2, Users, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Button } from '@/ui/primitives';
import { shrinkPhoto } from '@/ui/proof-photo';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';
import { PartsBar } from './parts';
import { Lightbox } from '../manage/inbox/chat-ui';

interface Receipt {
  id: string;
  url: string;
  fromGroup: boolean;
  at: string | null;
}

interface Payment {
  id: string;
  receiptId: string;
  status: 'READING' | 'READ' | 'UNREAD' | 'EDITED';
  amount: string | null;
  currency: string | null;
  account: string | null;
  name: string | null;
  editedByName: string | null;
  accountMatches: boolean | null;
  otherMoney: boolean;
}

interface Summary {
  total: string;
  currency: string;
  paid: string;
  remaining: string;
  over: string;
  pending: boolean;
  payments: Payment[];
}

const plain = (scaled: string) => {
  const value = Number(scaled) / 1e8;
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '';
};

/**
 * A transfer's receipts, as many as it took: each opened, each taken off when
 * wrong, more added from the desk, and looked for again in the groups it was
 * passed on to — every photo answering it there is one.
 */
export function ReceiptsPanel({
  kind,
  id,
  version = 0,
  onChanged,
}: {
  kind: 'deal' | 'request' | 'tiktok';
  id: string;
  version?: number;
  onChanged?: () => void;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [busy, setBusy] = useState<'add' | 'collect' | null>(null);
  const [removing, setRemoving] = useState<Receipt | null>(null);
  /** A receipt opened over everything. */
  const [viewing, setViewing] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      ),
    [toast, t],
  );

  useEffect(() => {
    api
      .get<Receipt[]>(`/api/bank/receipts?kind=${kind}&id=${encodeURIComponent(id)}`)
      .then(setReceipts)
      .catch(() => setReceipts([]));
  }, [kind, id, version]);

  // What each receipt shows was sent, and what is left.
  const [summary, setSummary] = useState<Summary | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const readSummary = useCallback(async () => {
    try {
      setSummary(await api.get<Summary>(`/api/bank/payments?kind=${kind}&id=${encodeURIComponent(id)}`));
    } catch {
      // Only a help: the receipts stand without it.
    }
  }, [kind, id]);
  useEffect(() => {
    void readSummary();
  }, [readSummary, receipts]);
  const reading = summary?.payments.some((payment) => payment.status === 'READING') ?? false;
  const lastPaid = useRef<string | null>(null);
  useEffect(() => {
    if (!reading) return;
    const timer = setInterval(() => void readSummary(), 3_000);
    return () => clearInterval(timer);
  }, [reading, readSummary]);
  // A sum read or written: the desk's list shows what is left too.
  useEffect(() => {
    if (!summary) return;
    if (lastPaid.current !== null && lastPaid.current !== summary.paid) onChanged?.();
    lastPaid.current = summary.paid;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.paid]);

  const saveAmount = async () => {
    if (!editing) return;
    try {
      setSummary(
        await api.patch<Summary>('/api/bank/payments', {
          paymentId: editing.id,
          amount: editing.value.trim() || null,
        }),
      );
      setEditing(null);
    } catch (cause) {
      failure(cause);
    }
  };
  const paymentOf = (receipt: Receipt) => summary?.payments.find((payment) => payment.receiptId === receipt.id);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy('add');
    try {
      let latest: Receipt[] | null = null;
      for (const file of [...files].slice(0, 6)) {
        const receipt = await shrinkPhoto(file);
        latest = await api.post<Receipt[]>('/api/bank/receipts', { action: 'add', kind, id, receipt });
      }
      if (latest) setReceipts(latest);
      toast.success(t('bankReceipts.added'));
      onChanged?.();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(null);
    }
  };

  const collect = async () => {
    setBusy('collect');
    try {
      const result = await api.post<{ added: number; groups: number; receipts: Receipt[] }>('/api/bank/receipts', {
        action: 'collect',
        kind,
        id,
      });
      setReceipts(result.receipts);
      if (result.added > 0) {
        toast.success(t('bankReceipts.collected', { count: result.added }));
        onChanged?.();
      } else {
        toast.success(t('bankReceipts.noneNew'), result.groups ? t('bankReceipts.lookedIn', { count: result.groups }) : undefined);
      }
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      setReceipts(
        await api.delete<Receipt[]>(
          `/api/bank/receipts?kind=${kind}&id=${encodeURIComponent(id)}&receiptId=${encodeURIComponent(removing.id)}`,
        ),
      );
      setRemoving(null);
      onChanged?.();
    } catch (cause) {
      failure(cause);
    }
  };

  return (
    <section className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
          <Receipt className="size-3.5" />
          {t('bankReceipts.title')}
          {receipts && receipts.length > 0 && (
            <span className="rounded-full bg-primary-subtle px-1.5 text-[10px] font-bold text-primary-text">{receipts.length}</span>
          )}
        </h3>
      </div>

      {summary && BigInt(summary.paid) > 0n && (
        <div className="mb-2 rounded-xl bg-surface-sunken p-2.5">
          <div className="grid grid-cols-3 gap-2 text-center">
            {(
              [
                ['total', summary.total, 'text-content'],
                ['sent', summary.paid, 'text-success-text'],
                ['left', summary.remaining, BigInt(summary.remaining) > 0n ? 'text-warning-text' : 'text-content-tertiary'],
              ] as const
            ).map(([key, value, tone]) => (
              <span key={key} className="min-w-0">
                <span className="block text-[10px] font-semibold text-content-tertiary">{t(`bankParts.sum.${key}`)}</span>
                <span className={cn('ltr-content block truncate text-sm font-extrabold tabular-nums', tone)}>
                  <Money value={value} currency={summary.currency} />
                </span>
              </span>
            ))}
          </div>
          <PartsBar amount={summary.total} paid={summary.paid} currency={summary.currency} className="mt-2 [&>span:first-child]:hidden" />
          {BigInt(summary.over) > 0n && (
            <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold text-danger-text">
              <AlertTriangle className="size-3.5" />
              {t('bankParts.over')} <Money value={summary.over} currency={summary.currency} />
            </p>
          )}
        </div>
      )}

      {receipts === null ? null : receipts.length === 0 ? (
        <p className="mb-2 text-xs text-content-tertiary">{t('bankReceipts.none')}</p>
      ) : (
        <div className="mb-2 grid grid-cols-2 gap-2.5">
          {receipts.map((receipt, index) => {
            const payment = paymentOf(receipt);
            const wrong = payment?.accountMatches === false;
            return (
              <figure
                key={receipt.id}
                className={cn(
                  'group relative overflow-hidden rounded-xl bg-surface ring-1 transition-shadow hover:shadow-md',
                  wrong ? 'ring-2 ring-danger' : 'ring-border-subtle',
                )}
              >
                {/* The receipt itself, whole: opened over everything on a press. */}
                <button
                  type="button"
                  onClick={() => setViewing(receipt.url)}
                  className="relative block w-full bg-[repeating-linear-gradient(45deg,var(--color-surface-sunken)_0_8px,transparent_8px_16px)]"
                  aria-label={t('bankReceipts.open')}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={receipt.url}
                    alt=""
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden';
                    }}
                    className="mx-auto aspect-[3/4] w-full object-contain transition-transform group-hover:scale-[1.02]"
                  />
                  <span className="absolute start-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-[10px] font-bold text-white">
                    {index + 1}
                  </span>
                  {receipt.fromGroup && (
                    <span
                      title={t('bankReceipts.fromGroup')}
                      className="absolute bottom-1.5 start-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-px text-[9px] font-semibold text-white"
                    >
                      <Users className="size-2.5" />
                      {t('bankReceipts.group')}
                    </span>
                  )}
                  <span className="absolute inset-0 hidden items-center justify-center bg-black/25 text-white group-hover:flex">
                    <Maximize2 className="size-6 drop-shadow" />
                  </span>
                </button>

                {/* What it says was sent: read by the bot, or written by hand. */}
                <figcaption className="flex items-center gap-1.5 border-t border-border-subtle px-2 py-1.5">
                  {payment ? (
                    <button
                      type="button"
                      title={t('bankParts.editHint')}
                      onClick={() => setEditing({ id: payment.id, value: payment.amount ? plain(payment.amount) : '' })}
                      className={cn(
                        'inline-flex min-w-0 flex-1 items-center gap-1 rounded-lg px-1.5 py-1 text-start text-xs font-extrabold transition-colors hover:bg-surface-sunken',
                        payment.status === 'READING'
                          ? 'text-content-tertiary'
                          : payment.amount
                            ? payment.otherMoney
                              ? 'text-warning-text'
                              : 'text-success-text'
                            : 'text-warning-text',
                      )}
                    >
                      {payment.status === 'READING' ? (
                        <>
                          <Loader2 className="size-3.5 shrink-0 animate-spin" />
                          <span className="truncate font-semibold">{t('bankParts.reading')}</span>
                        </>
                      ) : payment.amount ? (
                        <>
                          <span className="ltr-content truncate tabular-nums">
                            {plain(payment.amount)} {payment.currency ?? summary?.currency ?? ''}
                          </span>
                          <Pencil className="size-3 shrink-0 opacity-0 group-hover:opacity-60" />
                        </>
                      ) : (
                        <>
                          <Pencil className="size-3.5 shrink-0" />
                          <span className="truncate">{t('bankParts.unread')}</span>
                        </>
                      )}
                    </button>
                  ) : (
                    <span className="flex-1" />
                  )}
                  <button
                    type="button"
                    onClick={() => setRemoving(receipt)}
                    aria-label={t('bankReceipts.remove')}
                    title={t('bankReceipts.remove')}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-content-tertiary hover:bg-danger-subtle hover:text-danger-text"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </figcaption>
                {wrong && (
                  <p
                    title={payment?.account ?? ''}
                    className="flex items-center gap-1 bg-danger px-2 py-1 text-[10px] font-bold text-white"
                  >
                    <AlertTriangle className="size-3 shrink-0" />
                    <span className="truncate">
                      {t('bankParts.otherAccount')}
                      {payment?.account && <span className="ltr-content font-mono"> · {payment.account}</span>}
                    </span>
                  </p>
                )}
              </figure>
            );
          })}
        </div>
      )}

      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          void add(event.target.files);
          event.target.value = '';
        }}
      />
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" variant="secondary" icon={<ImagePlus />} loading={busy === 'add'} onClick={() => picker.current?.click()}>
          {t('bankReceipts.add')}
        </Button>
        <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={busy === 'collect'} onClick={() => void collect()}>
          {t('bankReceipts.collect')}
        </Button>
      </div>

      {editing && (
        <div className="mt-2 flex items-center gap-1.5 rounded-xl bg-surface-sunken p-2 ring-1 ring-primary/40">
          <span className="shrink-0 text-[11px] font-semibold text-content-secondary">{t('bankParts.editLabel')}</span>
          <input
            autoFocus
            dir="ltr"
            inputMode="decimal"
            value={editing.value}
            onChange={(event) => setEditing({ ...editing, value: event.target.value.replace(/[^\d.]/g, '') })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveAmount();
              if (event.key === 'Escape') setEditing(null);
            }}
            className="h-8 min-w-0 flex-1 rounded-lg bg-surface px-2 text-end text-sm font-bold tabular-nums outline-none ring-1 ring-border-subtle focus:ring-primary"
          />
          <Button size="sm" variant="primary" onClick={() => void saveAmount()}>
            {t('common.save')}
          </Button>
          <button
            type="button"
            onClick={() => setEditing(null)}
            aria-label={t('common.cancel')}
            className="inline-flex size-8 items-center justify-center rounded-lg text-content-tertiary hover:bg-surface"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <Lightbox src={viewing} onClose={() => setViewing(null)} label={t('bankReceipts.title')} />

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        title={t('bankReceipts.removeTitle')}
        message={t('bankReceipts.removeHint')}
        confirmLabel={t('bankReceipts.remove')}
        cancelLabel={t('common.cancel')}
        tone="danger"
      />
    </section>
  );
}
