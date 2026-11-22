'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Copy, ExternalLink, Loader2, Timer, XCircle } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { networkLabel } from '@/lib/network-label';
import { Badge, Button } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { DateText, Money } from '@/ui/display';
import { cn } from '@/ui/utils';

export interface ChainDetail {
  id: string;
  txHash: string;
  network: string;
  direction: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  splitSettled: string;
  tokenSymbol: string;
  blockNumber: string | null;
  blockTimestamp: string | null;
  firstSeenAt: string;
  confirmations: number;
  required: number;
  status: string;
  ready: boolean;
  wallet: { id: string; label: string; labelAr: string; address: string; isCounterAddress: boolean };
  deal: { id: string; reference: string } | null;
  claimed: boolean;
  explorer: { tx: string | null; addresses: Record<string, string | null>; name: string | null };
}

/** While it settles, read again this often: the confirmations climb in front of the teller. */
const LIVE_MS = 4_000;

/**
 * One transfer as an explorer shows it — inside the program, so the teller
 * need not leave the customer to check it, with the public page one press away.
 */
export function TxDetailDialog({
  id,
  onClose,
  onRecord,
}: {
  id: string | null;
  onClose: () => void;
  /** Offered when the transfer is settled and nobody has recorded it. */
  onRecord?: (detail: ChainDetail) => void;
}) {
  const { t, ln } = useLocale();
  const toast = useToast();
  const [detail, setDetail] = useState<ChainDetail | null>(null);

  useEffect(() => {
    setDetail(null);
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const next = await api.get<ChainDetail>(`/api/usdt/chain/${id}`);
        if (stopped) return;
        setDetail(next);
        if (!next.ready && next.status !== 'FAILED') timer = setTimeout(() => void read(), LIVE_MS);
      } catch {
        if (!stopped) timer = setTimeout(() => void read(), LIVE_MS * 2);
      }
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    toast.success(t('chainTx.copied'), value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value);
  };

  const progress = detail ? Math.min(100, Math.round((detail.confirmations / Math.max(1, detail.required)) * 100)) : 0;
  const paid = detail ? BigInt(detail.splitSettled || '0') : 0n;

  return (
    <Dialog
      open={Boolean(id)}
      onClose={onClose}
      title={t('chainTx.title')}
      size="lg"
      footer={
        detail ? (
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            {detail.explorer.tx && (
              <a
                href={detail.explorer.tx}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-10 items-center gap-1.5 rounded-[var(--radius-control)] border border-border-base px-3 text-sm font-medium text-content-secondary transition-colors hover:border-primary hover:text-primary-text"
              >
                <ExternalLink className="size-4" />
                {t('receive.openExplorer', { name: detail.explorer.name ?? '' })}
              </a>
            )}
            {onRecord && detail.ready && !detail.claimed && detail.direction === 'IN' && detail.wallet.isCounterAddress && (
              <Button onClick={() => onRecord(detail)}>{t('chainTx.record')}</Button>
            )}
          </div>
        ) : undefined
      }
    >
      {!detail ? (
        <div className="flex justify-center py-10">
          <Loader2 className="size-6 animate-spin text-content-tertiary" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* The figure and where it stands, as the top of an explorer's page. */}
          <div className="rounded-2xl bg-surface-sunken p-4 text-center">
            <p className="text-3xl font-extrabold tabular-nums text-content">
              <Money value={detail.amount} currency={detail.tokenSymbol} />
            </p>
            <p className="mt-1 text-xs text-content-tertiary">{networkLabel(detail.network)}</p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              {detail.status === 'FAILED' ? (
                <Badge tone="danger">
                  <XCircle className="me-1 inline size-3.5" />
                  {t('chainTx.failed')}
                </Badge>
              ) : detail.ready ? (
                <Badge tone="success">
                  <CheckCircle2 className="me-1 inline size-3.5" />
                  {t('chainTx.confirmed', { confirmations: detail.confirmations })}
                </Badge>
              ) : (
                <Badge tone="warning">
                  <Timer className="me-1 inline size-3.5" />
                  {t('chainTx.confirming', { confirmations: detail.confirmations, required: detail.required })}
                </Badge>
              )}
              {detail.claimed ? (
                <Badge tone="primary">
                  {detail.deal ? `${t('chainTx.claimed')} ${detail.deal.reference}` : t('chainTx.claimedNoRef')}
                </Badge>
              ) : (
                <Badge tone="neutral">{t('chainTx.waiting')}</Badge>
              )}
              {paid > 0n && (
                <Badge tone="neutral">
                  {t('chainTx.partPaid', { paid: `${(Number(paid) / 1e8).toLocaleString('en-US')} ${detail.tokenSymbol}` })}
                </Badge>
              )}
            </div>
            {!detail.ready && detail.status !== 'FAILED' && (
              <div className="mx-auto mt-3 h-1.5 max-w-xs overflow-hidden rounded-full bg-border-subtle">
                <div className="h-full rounded-full bg-warning transition-all duration-700" style={{ width: `${progress}%` }} />
              </div>
            )}
          </div>

          <dl className="divide-y divide-border-subtle rounded-2xl border border-border-subtle text-sm">
            <Row label={t('chainTx.hash')}>
              <Mono value={detail.txHash} href={detail.explorer.tx} onCopy={copy} copyLabel={t('chainTx.copy')} />
            </Row>
            <Row label={t('chainTx.from')}>
              <Mono
                value={detail.fromAddress}
                href={detail.explorer.addresses[detail.fromAddress] ?? null}
                onCopy={copy}
                copyLabel={t('chainTx.copy')}
              />
            </Row>
            <Row label={t('chainTx.to')}>
              <span className="mb-1 flex items-center gap-1.5">
                <Badge tone="primary">{t('chainTx.ours')}</Badge>
                <span className="text-xs font-semibold text-content">{ln(detail.wallet, 'label')}</span>
              </span>
              <Mono
                value={detail.toAddress}
                href={detail.explorer.addresses[detail.toAddress] ?? null}
                onCopy={copy}
                copyLabel={t('chainTx.copy')}
              />
            </Row>
            <Row label={t('chainTx.network')}>{networkLabel(detail.network)}</Row>
            {detail.blockNumber && (
              <Row label={t('chainTx.block')}>
                <span className="font-mono tabular-nums ltr-content">{Number(detail.blockNumber).toLocaleString('en-US')}</span>
              </Row>
            )}
            {detail.blockTimestamp && (
              <Row label={t('chainTx.time')}>
                <DateText value={detail.blockTimestamp} withTime />{' '}
                <span className="text-xs text-content-tertiary">
                  (<DateText value={detail.blockTimestamp} relative />)
                </span>
              </Row>
            )}
            <Row label={t('chainTx.seen')}>
              <DateText value={detail.firstSeenAt} withTime />
            </Row>
          </dl>
        </div>
      )}
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-3 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs font-medium text-content-tertiary sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 text-content">{children}</dd>
    </div>
  );
}

function Mono({
  value,
  href,
  onCopy,
  copyLabel,
}: {
  value: string;
  href: string | null;
  onCopy: (value: string) => void;
  copyLabel: string;
}) {
  return (
    <span className="flex items-start gap-1.5">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('min-w-0 break-all font-mono text-xs text-primary-text ltr-content hover:underline')}
        >
          {value}
        </a>
      ) : (
        <span className="min-w-0 break-all font-mono text-xs ltr-content">{value}</span>
      )}
      <button
        type="button"
        onClick={() => onCopy(value)}
        aria-label={copyLabel}
        title={copyLabel}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-content-tertiary hover:bg-surface-sunken hover:text-content"
      >
        <Copy className="size-3.5" />
      </button>
    </span>
  );
}
