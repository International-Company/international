'use client';

import { useEffect, useState } from 'react';
import { Check, ClipboardPaste } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Money } from '@/ui/display';
import { PhotoField } from '@/ui/photo-field';
import { shrinkPhoto } from '@/ui/proof-photo';
import type { Line } from './desk-types';

/**
 * Sent from the bank: said so with the bank's receipt when there is one. A deal
 * is marked on the deal; a group's request is answered in its group.
 */
export function MarkSentDialog({
  line,
  onClose,
  onDone,
}: {
  line: Line | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (line) setReceipt(null);
  }, [line]);

  // A screenshot of the bank's receipt pasted with Ctrl+V lands here, without choosing a file.
  useEffect(() => {
    if (!line) return;
    const paste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.items ?? [])]
        .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile();
      if (!file) return;
      event.preventDefault();
      shrinkPhoto(file)
        .then((photo) => {
          setReceipt(photo);
          toast.success(t('bankDesk.pasted'));
        })
        .catch(() => toast.error(t('errors.title'), t('errors.proofImageInvalid')));
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [line, toast, t]);

  const send = async () => {
    if (!line) return;
    setBusy(true);
    try {
      await api.post(
        line.source === 'group'
          ? `/api/bank/requests/${line.id}`
          : line.source === 'tiktok'
            ? `/api/bank/tiktok/${line.id}`
            : `/api/bank/${line.id}`,
        {
        receipt,
      });
      toast.success(t('bank.sentDone'), line.reference);
      onDone();
      onClose();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={line !== null}
      onClose={onClose}
      title={t('bank.markSentTitle')}
      description={
        line ? t('bank.markSentHint', { name: line.name ?? line.account ?? '', channel: line.channel ?? '' }) : ''
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} icon={<Check />} onClick={() => void send()}>
            {t('bank.markSentConfirm')}
          </Button>
        </>
      }
    >
      {line && (
        <div className="space-y-3">
          <p className="text-center">
            <Money value={line.amount} currency={line.currency} className="text-2xl font-bold" />
          </p>
          <PhotoField label={t('bank.receipt')} attach={t('bank.receiptAttach')} value={receipt} onChange={setReceipt} />
          {!receipt && (
            <p className="flex items-center justify-center gap-1.5 text-center text-xs text-content-tertiary">
              <ClipboardPaste className="size-3.5" />
              {t('bankDesk.pasteHint')}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
