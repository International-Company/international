'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { CalendarDays, Check, Clock, Copy, ExternalLink, Landmark, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { Button, Skeleton } from '@/ui/primitives';
import { Money } from '@/ui/display';
import { useToast } from '@/ui/overlay';
import { cn } from '@/ui/utils';
import { clockOf, dayKey, dayLabel } from './days';

interface Detail {
  id: string;
  reference: string;
  kind: string;
  at: string;
  status: string;
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
  fromCurrency: string;
  fromAmount: string;
  toAmount: string;
  rate: string;
  intakeCash: string;
  intakeTransfer: string;
  intakeChannel: string | null;
  payoutCash: string;
  customerCode: string | null;
  counterpartyName: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  recipientIdNumber: string | null;
  delivered: { amount: string; unit: string } | null;
  branch: string | null;
  proofs: { id: string; kind: string }[];
}

/** A 1e8-scaled rate as the counter reads it: "3.65", "0.2740". */
function rateText(scaled: string): string {
  const value = Number(scaled) / 1e8;
  return value >= 1 ? value.toFixed(4).replace(/0{1,2}$/, '') : value.toFixed(4);
}

/** A stored amount as the bank's app takes it: "320", "12.5". */
function plain(scaled: string): string {
  const value = Number(scaled) / 1e8;
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
}

/**
 * One transfer in full, beside the list: the day and the hour it was promised,
 * where it goes and to whom, the deal behind it, who recorded it, its photos —
 * and the button that says it went.
 */
export function TransferDetail({
  id,
  onClose,
  onSend,
}: {
  id: string | null;
  onClose: () => void;
  /** Opens the list's own "sent" confirmation for this transfer. */
  onSend: (id: string) => void;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!id) return;
    setDetail(null);
    setFailed(false);
    api
      .get<Detail>(`/api/bank/${id}`)
      .then(setDetail)
      .catch(() => setFailed(true));
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [id, onClose]);

  if (!id) return null;

  const copy = (value: string, what: string) => {
    void navigator.clipboard?.writeText(value);
    toast.success(t('bank.copied'), what);
  };

  const Row = ({ label, children, copyable }: { label: string; children: ReactNode; copyable?: string }) => (
    <div className="flex items-start justify-between gap-3 py-2">
      <dt className="shrink-0 text-xs text-content-tertiary">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-end text-sm font-medium text-content">
        <span className="min-w-0 break-words">{children}</span>
        {copyable && (
          <button
            type="button"
            onClick={() => copy(copyable, label)}
            aria-label={label}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-primary-text"
          >
            <Copy className="size-3.5" />
          </button>
        )}
      </dd>
    </div>
  );

  const Section = ({ title, children }: { title: string; children: ReactNode }) => (
    <section className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">{title}</h3>
      <dl className="divide-y divide-border-subtle">{children}</dl>
    </section>
  );

  const pending = detail?.status === 'PENDING_TRANSFER';

  return createPortal(
    <div className="fixed inset-0 z-[55] flex" role="dialog" aria-modal="true" aria-label={t('bank.detailTitle')}>
      <button type="button" aria-label={t('common.close')} onClick={onClose} className="flex-1 bg-black/30 backdrop-blur-[1px]" />
      <aside className="flex h-full w-full max-w-md flex-col bg-surface-sunken shadow-[0_0_60px_-10px_rgb(0_0_0/0.4)]">
        {/* --- The head: what it is, and the sum --- */}
        <header className="border-b border-border-subtle bg-surface p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-content-secondary">
              {detail?.kind ?? t('bank.detailTitle')}
              {detail && <span className="ms-1.5 font-mono text-content-tertiary ltr-content">{detail.reference}</span>}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="inline-flex size-8 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
            >
              <X className="size-4" />
            </button>
          </div>
          {detail && (
            <>
              <button
                type="button"
                onClick={() => copy(plain(detail.amount), t('bank.amount'))}
                className="mt-2 block"
                title={t('bank.amount')}
              >
                <Money value={detail.amount} currency={detail.currency} className="text-3xl font-bold text-content" />
              </button>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2 py-0.5 font-semibold text-primary-text">
                  <Landmark className="size-3.5" />
                  {detail.channel ?? t('bank.noChannel')}
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 font-semibold',
                    pending ? 'bg-warning-subtle text-warning-text' : 'bg-success-subtle text-success-text',
                  )}
                >
                  {pending ? t('bankFeed.waiting') : detail.status === 'REVERSED' ? t('bankFeed.reversed') : t('bankFeed.sent')}
                </span>
              </div>
            </>
          )}
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {failed ? (
            <p className="p-4 text-center text-sm text-danger-text">{t('errors.generic')}</p>
          ) : !detail ? (
            <>
              <Skeleton className="h-20" />
              <Skeleton className="h-40" />
              <Skeleton className="h-32" />
            </>
          ) : (
            <>
              {/* --- When --- */}
              <div className="flex items-center gap-3 rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary-text">
                  <CalendarDays className="size-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-content">
                    {dayLabel(dayKey(detail.at), locale, {
                      today: t('bank.period.today'),
                      yesterday: t('bank.period.yesterday'),
                    })}
                    <span className="ms-1.5 font-normal text-content-tertiary ltr-content">{dayKey(detail.at)}</span>
                  </p>
                  <p className="flex items-center gap-1 text-xs text-content-secondary">
                    <Clock className="size-3.5" />
                    <span className="tabular-nums ltr-content">{clockOf(detail.at)}</span>
                    {detail.by && <> · {detail.by}</>}
                    {detail.branch && <> · {detail.branch}</>}
                  </p>
                </div>
              </div>

              {/* --- Where it goes --- */}
              <Section title={t('bank.detailTo')}>
                {detail.account && (
                  <Row label={t('bank.account')} copyable={detail.account}>
                    <span className="font-mono text-base tabular-nums ltr-content">{detail.account}</span>
                  </Row>
                )}
                {detail.name && (
                  <Row label={t('bank.name')} copyable={detail.name}>
                    {detail.name}
                  </Row>
                )}
                {detail.phone && detail.phone !== detail.account && (
                  <Row label={t('bank.phone')} copyable={detail.phone}>
                    <span className="tabular-nums ltr-content">{detail.phone}</span>
                  </Row>
                )}
                {detail.recipientIdNumber && (
                  <Row label={t('remittance.recipientIdNumber')} copyable={detail.recipientIdNumber}>
                    <span className="tabular-nums ltr-content">{detail.recipientIdNumber}</span>
                  </Row>
                )}
                {detail.customerCode && <Row label={t('bank.customer')}>{detail.customerCode}</Row>}
              </Section>

              {/* --- The deal behind it --- */}
              <Section title={t('bank.detailDeal')}>
                <Row label={t('bank.detailPaid')}>
                  <Money value={detail.fromAmount} currency={detail.fromCurrency} />
                </Row>
                <Row label={t('bank.detailGot')}>
                  <Money value={detail.toAmount} currency={detail.currency} />
                </Row>
                {detail.fromCurrency !== detail.currency && (
                  <Row label={t('bank.detailRate')}>
                    <span className="tabular-nums ltr-content">{rateText(detail.rate)}</span>
                  </Row>
                )}
                <Row label={t('bank.detailHow')}>
                  {BigInt(detail.payoutCash) > 0n ? (
                    <span>
                      {t('bank.detailSplit')} · <Money value={detail.amount} currency={detail.currency} /> +{' '}
                      <Money value={detail.payoutCash} currency={detail.currency} />
                    </span>
                  ) : (
                    t('bank.detailAllTransfer')
                  )}
                </Row>
                {BigInt(detail.intakeTransfer) > 0n && (
                  <Row label={t('bank.detailPaidBy')}>
                    {detail.intakeChannel ?? '—'} · <Money value={detail.intakeTransfer} currency={detail.fromCurrency} />
                  </Row>
                )}
                {detail.delivered && (
                  <Row label={t('bank.detailDelivered')}>
                    <span className="tabular-nums">
                      {plain(detail.delivered.amount)} {detail.delivered.unit}
                    </span>
                  </Row>
                )}
                {detail.counterpartyName && detail.counterpartyName !== detail.name && (
                  <Row label={t('transactions.counterpartyName')}>{detail.counterpartyName}</Row>
                )}
                {detail.notes && <Row label={t('common.notes')}>{detail.notes}</Row>}
              </Section>

              {/* --- Its photos --- */}
              {detail.proofs.length > 0 && (
                <section className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                    {t('bank.detailPhotos')}
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    {detail.proofs.map((proof) => (
                      <a key={proof.id} href={`/api/bank/${detail.id}/proofs/${proof.id}`} target="_blank" rel="noopener noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/bank/${detail.id}/proofs/${proof.id}`}
                          alt=""
                          className="aspect-square w-full rounded-lg object-cover ring-1 ring-border-subtle"
                        />
                      </a>
                    ))}
                  </div>
                </section>
              )}

              {detail.sentAt && (
                <p className="text-center text-xs text-success-text">
                  ✅ {t('bank.detailSentAt', { day: dayKey(detail.sentAt), time: clockOf(detail.sentAt) })}
                  {detail.sentBy && <> · {detail.sentBy}</>}
                </p>
              )}
            </>
          )}
        </div>

        {/* --- Doing it --- */}
        {detail && (
          <footer className="flex gap-2 border-t border-border-subtle bg-surface p-3">
            {pending && (
              <Button variant="primary" fullWidth icon={<Check />} onClick={() => onSend(detail.id)}>
                {t('bank.markSent')}
              </Button>
            )}
            <Link
              href={`/manage/transactions/${detail.id}`}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-sm font-medium text-primary-text ring-1 ring-border-subtle hover:bg-surface-sunken"
            >
              <ExternalLink className="size-4" />
              {t('bank.detailOpen')}
            </Link>
          </footer>
        )}
      </aside>
    </div>,
    document.body,
  );
}
