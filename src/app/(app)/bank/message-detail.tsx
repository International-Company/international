'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  CornerDownLeft,
  ExternalLink,
  Hourglass,
  Loader2,
  Maximize2,
  RefreshCw,
  ScanText,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { Money } from '@/ui/display';
import { Skeleton } from '@/ui/primitives';
import { cn } from '@/ui/utils';
import { Lightbox } from '../manage/inbox/chat-ui';
import { clockOf, dayKey, dayLabel } from './days';
import { PartsBar } from './parts';

interface Reading {
  provider: string | null;
  kind: string | null;
  status: string | null;
  amount: string | null;
  fee: string | null;
  total: string | null;
  currency: string | null;
  account: string | null;
  beneficiary: string | null;
  sender: string | null;
  reference: string | null;
  date: string | null;
}

interface Detail {
  group: string | null;
  image: string | null;
  reading: Reading | null;
  replied: boolean;
  quoted: {
    id: string;
    fromMe: boolean;
    senderName: string | null;
    senderPhone: string | null;
    text: string;
    mediaId: string | null;
    mediaKind: string | null;
    at: string;
  } | null;
  transfer: {
    kind: 'deal' | 'request' | 'tiktok';
    id: string;
    reference: string | null;
    account: string | null;
    name: string | null;
    channel: string | null;
    amount: string;
    currency: string;
    state: 'waiting' | 'sent' | 'cancelled';
    by: string | null;
    at: string;
    sentAt: string | null;
    sentBy: string | null;
    paid: string | null;
    receipts: number;
  } | null;
  isTransfer: boolean;
}

/** The last four digits of an account, as two writings of one number are matched. */
const tail = (value: string | null | undefined) => {
  const digits = value?.replace(/[^0-9]/g, '') ?? '';
  return digits.length >= 4 ? digits.slice(-4) : null;
};

/** A plain figure as money is read: 1,250.5. */
const grouped = (value: string) => {
  const [whole, fraction] = value.split('.');
  return `${whole!.replace(/(?=(?:[0-9]{3})+$)(?!^)/g, ',')}${fraction && Number(fraction) ? `.${fraction}` : ''}`;
};

function Section({ icon, title, aside, children }: { icon: ReactNode; title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl bg-surface ring-1 ring-border-subtle">
      <header className="flex items-center justify-between gap-2 border-b border-border-subtle px-3.5 py-2.5">
        <h3 className="flex items-center gap-2 text-[13px] font-bold text-content">
          <span className="text-primary-text [&>svg]:size-4">{icon}</span>
          {title}
        </h3>
        {aside}
      </header>
      <div className="p-3.5">{children}</div>
    </section>
  );
}

/**
 * A group's message opened in full: its photo large, what the receipt in it
 * says field by field — read once by the bot, each field copied with a press —
 * the transfer it answers or is and how far that got, and what it replies to.
 */
export function MessageDetail({
  id,
  text,
  fromMe,
}: {
  id: string;
  /** The message's own words, under its photo. */
  text: string;
  fromMe: boolean;
}) {
  const { t, locale } = useLocale();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState<'idle' | 'busy' | 'none'>('idle');
  const [copied, setCopied] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const asked = useRef<string | null>(null);

  const read = useCallback(
    async (again = false) => {
      setReading('busy');
      try {
        const result = await api.post<{ reading: Reading | null }>(`/api/bank/groups/messages/${id}/detail`, { again });
        setDetail((current) => (current ? { ...current, reading: result.reading } : current));
        setReading(result.reading ? 'idle' : 'none');
      } catch {
        setReading('none');
      }
    },
    [id],
  );

  useEffect(() => {
    setDetail(null);
    setFailed(false);
    setReading('idle');
    api
      .get<Detail>(`/api/bank/groups/messages/${id}/detail`)
      .then((found) => {
        setDetail(found);
        // A photo not read yet: read at once, so its fields are there by the time it is looked at.
        if (found.image && !found.reading && asked.current !== id) {
          asked.current = id;
          void read();
        }
      })
      .catch(() => setFailed(true));
  }, [id, read]);

  const copy = (key: string, value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(key);
    setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
  };
  const when = (at: string) =>
    `${dayLabel(dayKey(at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') })} · ${clockOf(at)}`;

  if (failed) return null;
  if (!detail) {
    return (
      <div className="mb-4 space-y-3">
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
    );
  }

  const r = detail.reading;
  const transfer = detail.transfer;
  const accountMatch = r?.account && transfer?.account ? tail(r.account) === tail(transfer.account) : null;
  const left = transfer ? BigInt(transfer.amount) - BigInt(transfer.paid ?? '0') : null;
  const readAmount = r?.amount ? BigInt(Math.round(Number(r.amount) * 100)) * 1_000_000n : null;
  const amountFits =
    readAmount !== null && transfer
      ? readAmount === BigInt(transfer.amount)
        ? 'whole'
        : left !== null && readAmount === left
          ? 'left'
          : readAmount < BigInt(transfer.amount)
            ? 'part'
            : 'over'
      : null;

  const Field = ({ k, label, value, mono, strong }: { k: string; label: string; value: string | null; mono?: boolean; strong?: boolean }) =>
    value ? (
      <button
        type="button"
        onClick={() => copy(k, value)}
        className={cn(
          'group flex min-w-0 flex-col items-start rounded-xl px-2.5 py-2 text-start transition-colors',
          copied === k ? 'bg-success-subtle' : 'bg-surface-sunken hover:bg-primary-subtle/50',
        )}
      >
        <span className="flex w-full items-center justify-between gap-1 text-[10px] font-semibold text-content-tertiary">
          {label}
          {copied === k ? (
            <ClipboardCheck className="size-3 text-success-text" />
          ) : (
            <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </span>
        <span
          className={cn(
            'w-full truncate text-content',
            strong ? 'text-lg font-extrabold' : 'text-[13px] font-semibold',
            mono && 'ltr-content font-mono tabular-nums',
          )}
        >
          {value}
        </span>
      </button>
    ) : null;

  const stateChip = (state: 'waiting' | 'sent' | 'cancelled') => (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold',
        state === 'sent' && 'bg-success-subtle text-success-text',
        state === 'waiting' && 'bg-warning-subtle text-warning-text',
        state === 'cancelled' && 'bg-danger-subtle text-danger-text',
      )}
    >
      {state === 'sent' ? <CheckCircle2 className="size-3" /> : state === 'waiting' ? <Hourglass className="size-3" /> : <Ban className="size-3" />}
      {t(`bankMsg.state.${state}`)}
    </span>
  );

  return (
    <div className="mb-5 space-y-3">
      {/* --- The message itself: its photo large, its words under it --- */}
      {(detail.image || text) && (
        <div className={cn('overflow-hidden rounded-2xl ring-1', fromMe ? 'bg-success-subtle/40 ring-success/20' : 'bg-surface ring-border-subtle')}>
          {detail.image && (
            <button
              type="button"
              onClick={() => setViewing(`/api/bank/groups/media/${detail.image}`)}
              className="group relative block w-full bg-[repeating-linear-gradient(45deg,var(--color-surface-sunken)_0_8px,transparent_8px_16px)]"
              aria-label={t('bankReceipts.open')}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/bank/groups/media/${detail.image}`}
                alt=""
                className="mx-auto max-h-[26rem] w-auto max-w-full object-contain"
              />
              <span className="absolute end-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[11px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
                <Maximize2 className="size-3.5" />
                {t('bankMsg.full')}
              </span>
            </button>
          )}
          {text && (
            <p className="whitespace-pre-wrap break-words px-3.5 py-2.5 text-sm font-semibold text-content">
              {text.replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n').trim()}
            </p>
          )}
        </div>
      )}

      {/* --- What the receipt says --- */}
      {detail.image && (
        <Section
          icon={<ScanText />}
          title={t('bankMsg.readTitle')}
          aside={
            r && (
              <button
                type="button"
                onClick={() => void read(true)}
                disabled={reading === 'busy'}
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-content-tertiary hover:text-primary-text disabled:opacity-50"
              >
                <RefreshCw className={cn('size-3', reading === 'busy' && 'animate-spin')} />
                {t('bankMsg.readAgain')}
              </button>
            )
          }
        >
          {reading === 'busy' && !r ? (
            <p className="flex items-center gap-2 py-3 text-sm text-content-secondary">
              <Loader2 className="size-4 animate-spin text-primary-text" />
              {t('bankMsg.reading')}
            </p>
          ) : !r ? (
            <div className="flex items-center justify-between gap-2 py-1">
              <p className="text-xs text-content-tertiary">{t('bankMsg.unread')}</p>
              <button
                type="button"
                onClick={() => void read(true)}
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-primary/90"
              >
                <ScanText className="size-3.5" />
                {t('bankMsg.readNow')}
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              {(r.provider || r.status || r.kind) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {r.provider && <span className="rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] font-bold text-primary-text">{r.provider}</span>}
                  {r.kind && <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-semibold text-content-secondary">{r.kind}</span>}
                  {r.status && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-[11px] font-bold text-success-text">
                      <CheckCircle2 className="size-3" />
                      {r.status}
                    </span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                <Field k="amount" label={t('bankMsg.amount')} value={r.amount ? `${grouped(r.amount)} ${r.currency ?? ''}`.trim() : null} mono strong />
                <Field k="fee" label={t('bankMsg.fee')} value={r.fee ? grouped(r.fee) : null} mono />
                <Field k="total" label={t('bankMsg.total')} value={r.total ? grouped(r.total) : null} mono />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field k="account" label={t('bankMsg.account')} value={r.account} mono />
                <Field k="beneficiary" label={t('bankMsg.beneficiary')} value={r.beneficiary} />
                <Field k="sender" label={t('bankMsg.sender')} value={r.sender} />
                <Field k="reference" label={t('bankMsg.reference')} value={r.reference} mono />
                <Field k="date" label={t('bankMsg.date')} value={r.date} mono />
              </div>
              {/* Checked against the transfer it belongs to. */}
              {transfer && (accountMatch !== null || amountFits) && (
                <div className="flex flex-wrap gap-1.5">
                  {accountMatch !== null && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold',
                        accountMatch ? 'bg-success-subtle text-success-text' : 'bg-danger text-white',
                      )}
                    >
                      {accountMatch ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
                      {accountMatch ? t('bankMsg.accountMatch') : t('bankMsg.accountOther')}
                    </span>
                  )}
                  {amountFits && (
                    <span
                      className={cn(
                        'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold',
                        amountFits === 'whole' || amountFits === 'left'
                          ? 'bg-success-subtle text-success-text'
                          : amountFits === 'part'
                            ? 'bg-warning-subtle text-warning-text'
                            : 'bg-danger text-white',
                      )}
                    >
                      {amountFits === 'over' ? <AlertTriangle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                      {t(`bankMsg.fits.${amountFits}`)}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </Section>
      )}

      {/* --- The transfer it is, or answers --- */}
      {transfer && (
        <Section
          icon={<CornerDownLeft />}
          title={detail.isTransfer ? t('bankMsg.isTransfer') : t('bankMsg.transfer')}
          aside={stateChip(transfer.state)}
        >
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <Money value={transfer.amount} currency={transfer.currency} className="text-2xl font-extrabold leading-none text-content" />
              <PartsBar amount={transfer.amount} paid={transfer.paid} currency={transfer.currency} size="lg" className="mt-2 max-w-xs" />
            </div>
            {transfer.kind === 'deal' && (
              <Link
                href={`/manage/transactions/${transfer.id}`}
                className="inline-flex items-center gap-1 rounded-lg bg-surface-sunken px-2.5 py-1.5 text-[11px] font-bold text-primary-text hover:bg-primary-subtle"
              >
                <span className="ltr-content font-mono">{transfer.reference}</span>
                <ExternalLink className="size-3.5" />
              </Link>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Field k="t-account" label={t('bankMsg.account')} value={transfer.account} mono />
            <Field k="t-name" label={t('bankMsg.beneficiary')} value={transfer.name} />
            <Field k="t-channel" label={t('bankMsg.channel')} value={transfer.channel} />
            <Field k="t-receipts" label={t('bankMsg.receipts')} value={String(transfer.receipts)} />
          </div>
          <dl className="mt-3 space-y-1 text-xs text-content-secondary">
            <div className="flex justify-between gap-2">
              <dt>{t('bankMsg.recorded')}</dt>
              <dd className="font-semibold text-content">
                {transfer.by ?? '—'} · <span className="tabular-nums">{when(transfer.at)}</span>
              </dd>
            </div>
            {transfer.sentAt && (
              <div className="flex justify-between gap-2">
                <dt>{t('bankMsg.sent')}</dt>
                <dd className="font-semibold text-success-text">
                  {transfer.sentBy ?? '—'} · <span className="tabular-nums">{when(transfer.sentAt)}</span>
                </dd>
              </div>
            )}
          </dl>
        </Section>
      )}

      {/* --- What it replies to --- */}
      {detail.replied && (
        <Section icon={<CornerDownLeft />} title={t('bankMsg.repliesTo')}>
          {detail.quoted ? (
            <div className="border-s-4 border-primary/60 ps-3">
              <p className="text-[11px] font-bold text-primary-text">
                {detail.quoted.fromMe
                  ? t('bankFeed.office')
                  : (detail.quoted.senderName ?? (detail.quoted.senderPhone ? `+${detail.quoted.senderPhone}` : t('bankFeed.member')))}
                <span className="ms-2 font-normal text-content-tertiary tabular-nums">{when(detail.quoted.at)}</span>
              </p>
              <p className="mt-0.5 line-clamp-6 whitespace-pre-wrap break-words text-sm text-content">{detail.quoted.text || '📎'}</p>
            </div>
          ) : (
            <p className="text-xs text-content-tertiary">{t('bankMsg.quotedNotKept')}</p>
          )}
        </Section>
      )}

      <Lightbox src={viewing} onClose={() => setViewing(null)} label={t('bankMsg.readTitle')} />
    </div>
  );
}
