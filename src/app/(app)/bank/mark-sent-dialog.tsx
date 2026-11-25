'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Check, ClipboardCheck, Copy, PictureInPicture2, SplitSquareHorizontal, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Money } from '@/ui/display';
import { shrinkPhoto } from '@/ui/proof-photo';
import { plainFigure, type Line } from './desk-types';
import { PartsBar, remainingOf } from './parts';

interface Field {
  key: string;
  label: string;
  value: string;
  mono: boolean;
}

/**
 * Something put on the clipboard from a window — this one, or the floating one
 * beside the bank's site, whose own clipboard is the one that will take it
 * while it has the focus. The old way where the browser refuses the new.
 */
function copyFrom(win: Window, value: string) {
  const fallback = () => {
    const field = win.document.createElement('textarea');
    field.value = value;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    win.document.body.appendChild(field);
    field.select();
    try {
      win.document.execCommand('copy');
    } finally {
      field.remove();
    }
  };
  if (win.navigator.clipboard?.writeText) win.navigator.clipboard.writeText(value).catch(fallback);
  else fallback();
}

/** The transfer's fields, each copied with a press, the last one copied ticked. */
function Fields({ fields, copied, onCopy }: { fields: Field[]; copied: string | null; onCopy: (field: Field) => void }) {
  const { t } = useLocale();
  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-border-subtle">
      {fields.map((field) => (
        <button
          key={field.key}
          type="button"
          onClick={() => onCopy(field)}
          className={`flex w-full items-center gap-2 border-b border-border-subtle px-2.5 py-1.5 text-start transition-colors last:border-b-0 ${
            copied === field.key ? 'bg-success-subtle/60' : 'hover:bg-surface-sunken'
          }`}
        >
          <span className="w-12 shrink-0 text-[11px] text-content-tertiary">{field.label}</span>
          <span
            className={`min-w-0 flex-1 truncate text-sm font-bold text-content ${field.mono ? 'ltr-content font-mono tabular-nums' : ''}`}
          >
            {field.value}
          </span>
          <span
            className={`inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold ${
              copied === field.key ? 'text-success-text' : 'text-primary-text'
            }`}
          >
            {copied === field.key ? <ClipboardCheck className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied === field.key ? t('bankSent.copied') : t('bankSent.copy')}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The receipt in one line: a press to choose it (or Ctrl+V), then its thumbnail. */
function Receipt({ value, onChange, onPick }: { value: string | null; onChange: (photo: string | null) => void; onPick: (file: File | undefined) => void }) {
  const { t } = useLocale();
  const input = useRef<HTMLInputElement>(null);
  return value ? (
    <div className="flex items-center gap-2 rounded-xl bg-success-subtle/40 p-1.5 ring-1 ring-success/30">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`data:image/jpeg;base64,${value}`} alt="" className="size-10 rounded-lg object-cover" />
      <span className="flex-1 text-xs font-semibold text-success-text">{t('bankSent.receiptReady')}</span>
      <button
        type="button"
        onClick={() => onChange(null)}
        aria-label={t('common.remove')}
        className="inline-flex size-7 items-center justify-center rounded-full text-content-tertiary hover:bg-surface hover:text-danger-text"
      >
        <X className="size-4" />
      </button>
    </div>
  ) : (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => {
          onPick(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border-strong px-3 py-2 text-xs font-semibold text-content-secondary hover:bg-surface-sunken"
      >
        <Camera className="size-4" />
        {t('bankSent.receiptPick')}
      </button>
    </>
  );
}

/**
 * Sent from the bank: the transfer's fields to copy into the bank's or Jawwal
 * Pay's site, its receipt, and the word that it went. The same in a floating
 * window that stays above every other — the bank's site included — so the
 * teller copies from it there and says it went without coming back.
 */
export function MarkSentDialog({
  line,
  onClose,
  onDone,
  floatOnly = false,
}: {
  line: Line | null;
  onClose: () => void;
  onDone: () => void;
  /** Straight to the floating window, from the row's own button, with no window here. */
  floatOnly?: boolean;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which field was copied last, shown ticked so the teller sees what is on the clipboard. */
  const [copied, setCopied] = useState<string | null>(null);
  /** The floating window, while it is open. */
  const [floating, setFloating] = useState<Window | null>(null);

  useEffect(() => {
    if (line) {
      setReceipt(null);
      setCopied(null);
    }
  }, [line]);

  // Leaving the bank desk: the floating window does not stay behind empty.
  const floatingRef = useRef<Window | null>(null);
  floatingRef.current = floating;
  useEffect(() => () => floatingRef.current?.close(), []);

  // Asked for from the row: opened at once, while the press still counts as one.
  const floatOnlyRef = useRef(floatOnly);
  floatOnlyRef.current = floatOnly;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (floatOnly && line && !floating) void openFloat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floatOnly, line]);

  // Closed here: the floating window goes with it.
  useEffect(() => {
    if (!line && floating) {
      floating.close();
      setFloating(null);
    }
  }, [line, floating]);

  const pick = (file: File | undefined) => {
    if (!file) return;
    shrinkPhoto(file)
      .then((photo) => {
        setReceipt(photo);
        toast.success(t('bankDesk.pasted'));
      })
      .catch(() => toast.error(t('errors.title'), t('errors.proofImageInvalid')));
  };

  // A screenshot of the receipt pasted with Ctrl+V — here, or in the floating window.
  useEffect(() => {
    if (!line) return;
    const paste = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.items ?? [])]
        .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile();
      if (!file) return;
      event.preventDefault();
      pick(file);
    };
    const docs = [document, ...(floating ? [floating.document] : [])];
    docs.forEach((doc) => doc.addEventListener('paste', paste));
    return () => docs.forEach((doc) => doc.removeEventListener('paste', paste));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line, floating]);

  /*
   * A part sent, the transfer left open: its receipt kept, read by the bot for
   * the sum, and the group told what is left. It closes on "sent" alone.
   */
  const [partBusy, setPartBusy] = useState(false);
  const sendPart = async () => {
    if (!line || !receipt) return;
    setPartBusy(true);
    try {
      await api.post('/api/bank/receipts', {
        action: 'add',
        kind: line.source === 'group' ? 'request' : line.source === 'tiktok' ? 'tiktok' : 'deal',
        id: line.id,
        receipt,
      });
      toast.success(t('bankParts.partKept'), t('bankParts.partKeptHint'));
      onDone();
      onClose();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      );
    } finally {
      setPartBusy(false);
    }
  };

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
        { receipt },
      );
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

  /*
   * The floating window: Chrome's and Edge's picture-in-picture for a page,
   * which stays above every window and tab; elsewhere a small window of its
   * own beside the bank's site. The program's styles go with it, so it looks
   * as it does here.
   */
  const openFloat = async () => {
    if (floating) {
      floating.focus();
      return;
    }
    const pip = (window as unknown as {
      documentPictureInPicture?: { requestWindow: (options: { width: number; height: number }) => Promise<Window> };
    }).documentPictureInPicture;
    let win: Window | null = null;
    try {
      win = pip ? await pip.requestWindow({ width: 340, height: 360 }) : window.open('', 'international-transfer', 'width=360,height=400');
    } catch {
      win = window.open('', 'international-transfer', 'width=360,height=400');
    }
    if (!win) {
      toast.error(t('errors.title'), t('bankSent.floatBlocked'));
      return;
    }
    for (const sheet of [...document.styleSheets]) {
      try {
        const style = win.document.createElement('style');
        style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
        win.document.head.appendChild(style);
      } catch {
        if (sheet.href) {
          const link = win.document.createElement('link');
          link.rel = 'stylesheet';
          link.href = sheet.href;
          win.document.head.appendChild(link);
        }
      }
    }
    win.document.documentElement.dir = document.documentElement.dir;
    win.document.documentElement.lang = document.documentElement.lang;
    win.document.documentElement.className = document.documentElement.className;
    win.document.title = t('bankSent.floatTitle');
    win.document.body.className = 'bg-surface text-content';
    win.document.body.style.margin = '0';
    win.addEventListener('pagehide', () => {
      setFloating(null);
      if (floatOnlyRef.current) onCloseRef.current();
    });
    setFloating(win);
  };

  const fields: Field[] = line
    ? [
        { key: 'account', label: t('bank.account'), value: line.account ?? '', mono: true },
        { key: 'name', label: t('bank.name'), value: line.name ?? '', mono: false },
        // Paid in parts: what is left is what is sent next.
        line.paid
          ? { key: 'amount', label: t('bankParts.left'), value: plainFigure(remainingOf(line.amount, line.paid).toString()), mono: true }
          : { key: 'amount', label: t('bank.amount'), value: plainFigure(line.amount), mono: true },
        { key: 'channel', label: t('bankSent.channel'), value: line.channel ?? '', mono: false },
      ].filter((field) => field.value)
    : [];

  return (
    <>
      <Dialog
        open={line !== null && !floatOnly}
        onClose={onClose}
        size="sm"
        title={t('bank.markSentTitle')}
        footer={
          <div className="flex w-full items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<PictureInPicture2 />}
              onClick={() => void openFloat()}
              title={t('bankSent.floatHint')}
              className="me-auto"
            >
              {t('bankSent.float')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<SplitSquareHorizontal />}
              loading={partBusy}
              disabled={!receipt || busy}
              title={receipt ? t('bankParts.partHint') : t('bankParts.partNeedsReceipt')}
              onClick={() => void sendPart()}
            >
              {t('bankParts.part')}
            </Button>
            <Button variant="primary" size="sm" loading={busy} icon={<Check />} onClick={() => void send()}>
              {t('bank.markSentConfirm')}
            </Button>
          </div>
        }
      >
        {line && (
          <div className="space-y-2.5">
            <div className="text-center">
              <Money value={line.amount} currency={line.currency} className="text-xl font-bold" />
              <PartsBar amount={line.amount} paid={line.paid} currency={line.currency} size="lg" className="mx-auto mt-1.5 max-w-[14rem] text-start" />
            </div>
            <Fields
              fields={fields}
              copied={copied}
              onCopy={(field) => {
                copyFrom(window, field.value);
                setCopied(field.key);
              }}
            />
            <Receipt value={receipt} onChange={setReceipt} onPick={pick} />
            <p className="text-center text-[11px] leading-relaxed text-content-tertiary">
              {t('bankSent.groupHintShort', { account: line.account ?? '' })}
            </p>
          </div>
        )}
      </Dialog>

      {/* The same, floating above the bank's site. */}
      {floating &&
        line &&
        createPortal(
          <div className="flex min-h-screen flex-col gap-2 bg-surface p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-bold text-content">{line.name ?? line.account}</span>
                <span className="block text-[11px] text-content-tertiary">{line.reference}</span>
              </span>
              <span className="shrink-0 text-end">
                <Money value={line.amount} currency={line.currency} className="text-lg font-extrabold" />
                <PartsBar amount={line.amount} paid={line.paid} currency={line.currency} className="mt-0.5 w-28" />
              </span>
            </div>
            <Fields
              fields={fields}
              copied={copied}
              onCopy={(field) => {
                copyFrom(floating, field.value);
                setCopied(field.key);
              }}
            />
            <Receipt value={receipt} onChange={setReceipt} onPick={pick} />
            <div className="grid grid-cols-2 gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                icon={<SplitSquareHorizontal />}
                loading={partBusy}
                disabled={!receipt || busy}
                onClick={() => void sendPart()}
              >
                {t('bankParts.part')}
              </Button>
              <Button variant="primary" size="sm" loading={busy} icon={<Check />} onClick={() => void send()}>
                {t('bank.markSentConfirm')}
              </Button>
            </div>
            <p className="text-center text-[10px] text-content-tertiary">{t('bankSent.floatFoot')}</p>
          </div>,
          floating.document.body,
        )}
    </>
  );
}
