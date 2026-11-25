'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ImagePlus, Loader2, Pencil, RefreshCw, Receipt, Users, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Button } from '@/ui/primitives';
import { shrinkPhoto } from '@/ui/proof-photo';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';
import { PartsBar } from './parts';

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
        <div className="mb-2 grid grid-cols-3 gap-2">
          {receipts.map((receipt) => (
            <div key={receipt.id} className="group relative">
              <a href={receipt.url} target="_blank" rel="noopener noreferrer" className="block">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={receipt.url} alt="" className="aspect-square w-full rounded-lg object-cover ring-1 ring-border-subtle" />
              </a>
              {receipt.fromGroup && (
                <span
                  title={t('bankReceipts.fromGroup')}
                  className="absolute bottom-1 start-1 inline-flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-px text-[9px] font-semibold text-white"
                >
                  <Users className="size-2.5" />
                  {t('bankReceipts.group')}
                </span>
              )}
              {(() => {
                const payment = paymentOf(receipt);
                if (!payment) return null;
                return (
                  <span className="absolute inset-x-1 top-1 flex flex-col items-start gap-0.5">
                    <button
                      type="button"
                      title={t('bankParts.editHint')}
                      onClick={() => setEditing({ id: payment.id, value: payment.amount ? plain(payment.amount) : '' })}
                      className={cn(
                        'inline-flex max-w-full items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-bold shadow',
                        payment.status === 'READING'
                          ? 'bg-surface text-content-tertiary'
                          : payment.amount
                            ? payment.otherMoney
                              ? 'bg-warning text-white'
                              : 'bg-success text-white'
                            : 'bg-surface text-warning-text',
                      )}
                    >
                      {payment.status === 'READING' ? (
                        <>
                          <Loader2 className="size-2.5 animate-spin" />
                          {t('bankParts.reading')}
                        </>
                      ) : payment.amount ? (
                        <span className="ltr-content truncate">
                          {plain(payment.amount)} {payment.currency ?? summary?.currency ?? ''}
                        </span>
                      ) : (
                        <>
                          <Pencil className="size-2.5" />
                          {t('bankParts.unread')}
                        </>
                      )}
                    </button>
                    {payment.accountMatches === false && (
                      <span
                        title={payment.account ?? ''}
                        className="inline-flex items-center gap-0.5 rounded-full bg-danger px-1.5 py-px text-[9px] font-bold text-white shadow"
                      >
                        <AlertTriangle className="size-2.5" />
                        {t('bankParts.otherAccount')}
                      </span>
                    )}
                  </span>
                );
              })()}
              <button
                type="button"
                onClick={() => setRemoving(receipt)}
                aria-label={t('bankReceipts.remove')}
                className="absolute -end-1.5 -top-1.5 inline-flex size-6 items-center justify-center rounded-full bg-surface text-content-tertiary shadow ring-1 ring-border-subtle hover:text-danger-text sm:opacity-0 sm:group-hover:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
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
