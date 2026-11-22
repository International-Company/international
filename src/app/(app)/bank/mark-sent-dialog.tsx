'use client';

import { useEffect, useState } from 'react';
import { Check, ClipboardCheck, ClipboardPaste, Copy } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Money } from '@/ui/display';
import { PhotoField } from '@/ui/photo-field';
import { shrinkPhoto } from '@/ui/proof-photo';
import { plainFigure, type Line } from './desk-types';

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
  /** Which field was copied last, shown ticked so the teller sees what is on the clipboard. */
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (line) {
      setReceipt(null);
      setCopied(null);
    }
  }, [line]);

  const copy = (key: string, value: string) => {
    // The clipboard as the browser offers it, else the old way, which works where that is refused.
    const fallback = () => {
      const field = document.createElement('textarea');
      field.value = value;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      try {
        document.execCommand('copy');
      } finally {
        field.remove();
      }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).catch(fallback);
    else fallback();
    setCopied(key);
  };

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
          {/*
            What the transfer is typed with outside the program — in Jawwal Pay
            or the bank's site — each a press from the clipboard, in the order
            the form asks for them.
          */}
          <div className="overflow-hidden rounded-2xl ring-1 ring-border-subtle">
            {[
              { key: 'account', label: t('bank.account'), value: line.account ?? '', mono: true },
              { key: 'name', label: t('bank.name'), value: line.name ?? '', mono: false },
              { key: 'amount', label: t('bank.amount'), value: plainFigure(line.amount), mono: true },
              { key: 'channel', label: t('bankSent.channel'), value: line.channel ?? '', mono: false },
            ]
              .filter((field) => field.value)
              .map((field) => (
                <button
                  key={field.key}
                  type="button"
                  onClick={() => copy(field.key, field.value)}
                  className={`flex w-full items-center gap-3 border-b border-border-subtle px-3 py-2.5 text-start last:border-b-0 transition-colors ${
                    copied === field.key ? 'bg-success-subtle/60' : 'hover:bg-surface-sunken'
                  }`}
                >
                  <span className="w-16 shrink-0 text-xs text-content-tertiary">{field.label}</span>
                  <span className={`min-w-0 flex-1 truncate text-base font-bold text-content ${field.mono ? 'ltr-content font-mono tabular-nums' : ''}`}>
                    {field.value}
                  </span>
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold ${
                      copied === field.key ? 'text-success-text' : 'text-primary-text'
                    }`}
                  >
                    {copied === field.key ? <ClipboardCheck className="size-4" /> : <Copy className="size-4" />}
                    {copied === field.key ? t('bankSent.copied') : t('bankSent.copy')}
                  </span>
                </button>
              ))}
          </div>
          <PhotoField label={t('bank.receipt')} attach={t('bank.receiptAttach')} value={receipt} onChange={setReceipt} />
          {!receipt && (
            <p className="flex items-center justify-center gap-1.5 text-center text-xs text-content-tertiary">
              <ClipboardPaste className="size-3.5" />
              {t('bankDesk.pasteHint')}
            </p>
          )}
          <p className="rounded-xl bg-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-content-secondary">
            {t('bankSent.groupHint', { account: line.account ?? '' })}
          </p>
        </div>
      )}
    </Dialog>
  );
}
