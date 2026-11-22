'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, RefreshCw, Receipt, Users, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Button } from '@/ui/primitives';
import { shrinkPhoto } from '@/ui/proof-photo';

interface Receipt {
  id: string;
  url: string;
  fromGroup: boolean;
  at: string | null;
}

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
