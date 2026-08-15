'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  Ban,
  Check,
  Clock,
  Copy,
  Loader2,
  Printer,
  RefreshCw,
  Wallet,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { QrCode } from '@/core/qr/qr-code';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { ShareButton } from '@/ui/share';
import { ReceiveFlow } from './receive-flow';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Textarea } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * The USDT window.
 *
 * Two screens in one: the teller's side, where a request is quoted and its
 * progress watched, and the customer's side — the address, the QR and the exact
 * amount — which is turned to face them.
 *
 * The customer's side is deliberately loud about the network. Sending TRC-20 to
 * an ERC-20 address destroys the money with no recourse from anyone, and it is
 * the single most common way people lose USDT. It is not a footnote here.
 */

interface CounterAddress {
  id: string;
  label: string;
  labelAr: string;
  network: string;
  address: string;
  tokenSymbol: string;
  minConfirmations: number;
  drawerId: string | null;
  isAutomatic: boolean;
}

interface OpenRequest {
  id: string;
  reference: string;
  network: string;
  address: string;
  expectedAmount: string;
  quotedAmount: string;
  quotedRate: string;
  payoutCurrency: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  counterpartyName: string | null;
  wallet: { label: string; labelAr: string; network: string };
  customer: { id: string; code: string; fullNameEn: string; fullNameAr: string } | null;
  transaction: { id: string; reference: string } | null;
  matchedChainTransaction: { txHash: string; confirmations: number } | null;
}

type MatchOutcome =
  | { state: 'WAITING'; confirmations: null }
  | { state: 'UNCONFIRMED'; confirmations: number; required: number; txHash: string }
  | { state: 'MATCHED'; chainTransactionId: string; txHash: string; confirmations: number }
  /** Plainly this customer's transfer, for a different figure. */
  | {
      state: 'NEAR';
      chainTransactionId: string;
      txHash: string;
      confirmations: number;
      arrived: string;
      expected: string;
      difference: string;
    }
  | { state: 'AMBIGUOUS'; candidates: { id: string; txHash: string; amount: string; seenAt: string }[] };

export function CounterView({
  addresses,
  openRequests,
  currencies,
  companyName,
  transferChannels,
  permissions,
}: {
  addresses: CounterAddress[];
  openRequests: OpenRequest[];
  currencies: { code: string; nameEn: string; nameAr: string; decimals: number }[];
  /** Named at the head of an address sent to a customer, so it is not anonymous. */
  companyName: string;
  /** The broker's accounts a transfer may be instructed to. */
  transferChannels: string[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [active, setActive] = useState<OpenRequest | null>(openRequests[0] ?? null);
  const [outcome, setOutcome] = useState<MatchOutcome | null>(null);
  const [checking, setChecking] = useState(false);
  const [settling, setSettling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const check = async (silent = false) => {
    if (!active) return;
    if (!silent) setChecking(true);
    try {
      const result = await api.post<MatchOutcome>(`/api/usdt/counter/${active.id}`, {
        action: 'check',
      });
      setOutcome(result);
      if (result.state === 'MATCHED') {
        setActive((current) =>
          current
            ? {
                ...current,
                status: 'MATCHED',
                matchedChainTransaction: {
                  txHash: result.txHash,
                  confirmations: result.confirmations,
                },
              }
            : current,
        );
      }
    } catch (cause) {
      if (!silent) toast.error(t('errors.title'), message(cause, t));
    } finally {
      if (!silent) setChecking(false);
    }
  };

  // While a request is open the chain is polled for the teller, so nobody has
  // to stand there pressing a button. It stops the moment there is nothing left
  // to wait for.
  useEffect(() => {
    if (!active || active.status !== 'OPEN') return;
    const timer = setInterval(() => void check(true), 12_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.status]);

  const attach = async (chainTransactionId: string, acceptDifference = false) => {
    if (!active) return;
    try {
      await api.post(`/api/usdt/counter/${active.id}`, {
        action: 'attach',
        chainTransactionId,
        acceptDifference,
      });
      toast.success(t('counter.attached'));
      await check();
    } catch (cause) {
      toast.error(t('errors.title'), message(cause, t));
    }
  };

  const settle = async () => {
    if (!active) return;
    setSettling(true);
    try {
      const result = await api.post<{ transaction: { id: string; reference: string } }>(
        `/api/usdt/counter/${active.id}`,
        { action: 'complete' },
      );
      toast.success(t('counter.settled'), result.transaction.reference);
      setActive((current) =>
        current ? { ...current, status: 'COMPLETED', transaction: result.transaction } : current,
      );
      router.refresh();
    } catch (cause) {
      toast.error(t('errors.title'), message(cause, t));
    } finally {
      setSettling(false);
    }
  };

  const cancel = async () => {
    if (!active) return;
    try {
      await api.post(`/api/usdt/counter/${active.id}`, { action: 'cancel', reason: cancelReason });
      toast.success(t('counter.cancelled'));
      setActive(null);
      setOutcome(null);
      setCancelling(false);
      setCancelReason('');
      router.refresh();
    } catch (cause) {
      toast.error(t('errors.title'), message(cause, t));
    }
  };

  return (
    <div className="space-y-4">
      {/*
        The window, in the order it actually works: the address is on the screen
        the moment it is chosen, the customer sends, and the teller types what
        arrived and asks the chain. Nothing is declared before the money exists.
      */}
      <ReceiveFlow
        addresses={addresses}
        currencies={currencies}
        companyName={companyName}
        transferChannels={transferChannels}
        permissions={permissions}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/*
          Requests opened under the older order, so work already in progress can
          still be finished. Nothing opens a new one.
        */}
      {/* --- Customer: the address, and what to send ---------------------- */}
      {active ? (
        <div className="space-y-4">
          <Card>
            <CardHeader
              title={<span className="font-mono ltr-content">{active.reference}</span>}
              actions={<StatusPill status={active.status} />}
            />
            <CardBody className="space-y-4">
              {active.status !== 'COMPLETED' && (
                <>
                  {/* The network, unmissable. Getting this wrong is unrecoverable. */}
                  <div className="rounded-[var(--radius-control)] border-2 border-warning bg-warning-subtle p-3 text-center">
                    <p className="text-xs font-medium uppercase tracking-wide text-content-secondary">
                      {t('counter.networkWarningLabel')}
                    </p>
                    <p className="mt-1 text-2xl font-bold text-content ltr-content">
                      {active.network}
                    </p>
                    <p className="mt-1 text-xs text-content-secondary">
                      {t('counter.networkWarningBody')}
                    </p>
                  </div>

                  <div className="flex justify-center">
                    <QrCode value={active.address} size={220} title={active.address} />
                  </div>

                  <AddressBlock address={active.address} onCopy={() => toast.success(t('common.copied'))} />

                  <div className="rounded-[var(--radius-control)] bg-surface-sunken p-3 text-center">
                    <p className="text-xs text-content-secondary">{t('counter.sendExactly')}</p>
                    <p className="mt-1 font-mono text-3xl font-bold text-content ltr-content tabular-nums">
                      <Money value={active.expectedAmount} /> USDT
                    </p>
                    <p className="mt-1 text-xs text-content-secondary">
                      {t('counter.exactAmountHint')}
                    </p>
                  </div>
                </>
              )}

              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-content-secondary">{t('counter.customerReceives')}</dt>
                  <dd className="font-medium text-content">
                    <Money value={active.quotedAmount} currency={active.payoutCurrency} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-content-secondary">{t('counter.expiresAt')}</dt>
                  <dd className="text-content">
                    <DateText value={active.expiresAt} withTime />
                  </dd>
                </div>
              </dl>

              <MatchState
                outcome={outcome}
                status={active.status}
                onAttach={(id) => void attach(id)}
                onAcceptDifference={(id) => void attach(id, true)}
              />

              <div className="grid grid-cols-2 gap-2">
                {active.status !== 'COMPLETED' && (
                  <Button
                    variant="secondary"
                    icon={checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    loading={checking}
                    onClick={() => void check()}
                  >
                    {t('counter.check')}
                  </Button>
                )}

                {active.status === 'MATCHED' && (
                  <Button
                    variant="primary"
                    icon={<Check />}
                    loading={settling}
                    onClick={() => void settle()}
                  >
                    {t('counter.settle')}
                  </Button>
                )}

                {active.status === 'COMPLETED' && active.transaction && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => router.push(`/manage/transactions/${active.transaction!.id}`)}
                    >
                      {active.transaction.reference}
                    </Button>
                    {permissions.includes('exchange.receipt.print') && (
                      <>
                        <Button
                          variant="secondary"
                          icon={<Printer />}
                          onClick={() =>
                            window.open(`/print/receipt/${active.transaction!.id}`, '_blank')
                          }
                        >
                          {t('transactions.printReceipt')}
                        </Button>
                        <ShareButton
                          transactionId={active.transaction.id}
                          variant="secondary"
                          size="md"
                        />
                      </>
                    )}
                  </>
                )}

                {active.status !== 'COMPLETED' && (
                  <Button variant="ghost" icon={<Ban />} onClick={() => setCancelling(true)}>
                    {t('common.cancel')}
                  </Button>
                )}
              </div>

              {active.status === 'COMPLETED' && (
                <Button variant="ghost" fullWidth onClick={() => setActive(null)}>
                  {t('counter.startAnother')}
                </Button>
              )}
            </CardBody>
          </Card>
        </div>
      ) : null}

      {/* --- Requests still waiting --------------------------------------- */}
      {openRequests.length > 0 && (
        <Card className="lg:col-span-2">
          <CardHeader title={t('counter.waitingTitle')} />
          <ul className="divide-y divide-border-base">
            {openRequests.map((request) => (
              <li key={request.id}>
                <button
                  type="button"
                  onClick={() => {
                    setActive(request);
                    setOutcome(null);
                  }}
                  className={cn(
                    'flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-start transition-colors hover:bg-surface-hover',
                    active?.id === request.id && 'bg-primary-subtle',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-sm text-content ltr-content">
                      {request.reference}
                    </span>
                    <StatusPill status={request.status} />
                  </span>
                  <span className="flex items-center gap-3 text-sm text-content-secondary">
                    <span className="ltr-content">
                      <Money value={request.expectedAmount} /> USDT
                    </span>
                    <span className="flex items-center gap-1 text-xs">
                      <Clock className="h-3 w-3" />
                      <DateText value={request.expiresAt} relative />
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        onConfirm={() => void cancel()}
        title={t('counter.cancelTitle')}
        confirmLabel={t('common.cancel')}
        cancelLabel={t('common.back')}
        tone="danger"
      >
        <Textarea
          value={cancelReason}
          onChange={(event) => setCancelReason(event.target.value)}
          placeholder={t('counter.cancelReason')}
          rows={3}
          required
        />
      </ConfirmDialog>
      </div>
    </div>
  );
}

/**
 * The address, split so a human can actually verify it.
 *
 * Nobody reads 34 characters accurately. The first and last six are what people
 * genuinely compare against their wallet, so those are large and the middle is
 * quiet — which is how the check is done in practice anyway.
 */
function AddressBlock({ address, onCopy }: { address: string; onCopy: () => void }) {
  const { t } = useLocale();
  const head = address.slice(0, 6);
  const tail = address.slice(-6);
  const middle = address.slice(6, -6);

  return (
    <div className="rounded-[var(--radius-control)] border border-border-base bg-surface p-3">
      <p className="break-all text-center font-mono text-sm ltr-content">
        <span className="text-base font-bold text-content">{head}</span>
        <span className="text-content-tertiary">{middle}</span>
        <span className="text-base font-bold text-content">{tail}</span>
      </p>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(address);
          onCopy();
        }}
        className="mt-2 flex w-full min-h-11 items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border-base text-sm text-content-secondary transition-colors hover:border-primary hover:text-primary-text"
      >
        <Copy className="h-4 w-4" />
        {t('counter.copyAddress', { length: String(address.length) })}
      </button>
    </div>
  );
}

function MatchState({
  outcome,
  status,
  onAttach,
  onAcceptDifference,
}: {
  outcome: MatchOutcome | null;
  status: string;
  onAttach: (chainTransactionId: string) => void;
  /** Settle the figure that arrived instead of the figure that was asked for. */
  onAcceptDifference: (chainTransactionId: string) => void;
}) {
  const { t } = useLocale();

  if (status === 'COMPLETED') {
    return <Alert tone="success">{t('counter.settledBody')}</Alert>;
  }
  if (!outcome) return null;

  switch (outcome.state) {
    case 'WAITING':
      return (
        <Alert tone="neutral" icon={<Clock />}>
          {t('counter.waitingBody')}
        </Alert>
      );

    case 'UNCONFIRMED':
      return (
        <Alert tone="warning" icon={<Loader2 className="animate-spin" />}>
          {t('counter.unconfirmedBody', {
            confirmations: String(outcome.confirmations),
            required: String(outcome.required),
          })}
        </Alert>
      );

    case 'MATCHED':
      return (
        <Alert tone="success" icon={<Check />} title={t('counter.matchedTitle')}>
          <span className="break-all font-mono text-xs ltr-content">{outcome.txHash}</span>
        </Alert>
      );

    /*
      The commonest real outcome after "not yet": they sent a different number.
      Both figures and the difference are named — nothing here is a tolerance
      the system forgives on its own, so the teller is shown exactly what they
      are agreeing to before the button says what it does.
    */
    case 'NEAR':
      return (
        <Alert tone="warning" icon={<AlertTriangle />} title={t('counter.nearTitle')}>
          <p className="mb-2 text-sm">{t('counter.nearBody')}</p>

          <dl className="mb-3 space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-content-secondary">{t('counter.nearArrived')}</dt>
              <dd className="font-semibold tabular-nums">
                <Money value={outcome.arrived} currency="USDT" />
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-content-secondary">{t('counter.nearExpected')}</dt>
              <dd className="tabular-nums">
                <Money value={outcome.expected} currency="USDT" />
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-t border-border-subtle pt-1">
              <dt className="text-content-secondary">{t('counter.nearDifference')}</dt>
              <dd className="font-semibold tabular-nums">
                <Money value={outcome.difference} currency="USDT" signed colored />
              </dd>
            </div>
          </dl>

          <span className="mb-2 block break-all font-mono text-xs ltr-content">
            {outcome.txHash}
          </span>

          <Button size="sm" onClick={() => onAcceptDifference(outcome.chainTransactionId)}>
            {t('counter.settleAtArrived')}
          </Button>
        </Alert>
      );

    case 'AMBIGUOUS':
      return (
        <Alert tone="warning" icon={<AlertTriangle />} title={t('counter.ambiguousTitle')}>
          <p className="mb-2 text-sm">{t('counter.ambiguousBody')}</p>
          <ul className="space-y-1">
            {outcome.candidates.map((candidate) => (
              <li key={candidate.id}>
                <button
                  type="button"
                  onClick={() => onAttach(candidate.id)}
                  className="w-full rounded-[var(--radius-control)] border border-border-base px-2 py-2 text-start transition-colors hover:border-primary"
                >
                  <span className="block break-all font-mono text-xs ltr-content">
                    {candidate.txHash}
                  </span>
                  <span className="text-xs text-content-secondary">
                    <DateText value={candidate.seenAt} withTime />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Alert>
      );
  }
}

function StatusPill({ status }: { status: string }) {
  const { t } = useLocale();

  const tone =
    status === 'COMPLETED'
      ? 'success'
      : status === 'MATCHED'
        ? 'primary'
        : status === 'OPEN'
          ? 'warning'
          : 'neutral';

  return <Badge tone={tone}>{t(`counter.status.${status}` as never)}</Badge>;
}

function message(cause: unknown, t: (key: never, params?: Record<string, string>) => string): string {
  return cause instanceof ApiError
    ? say(t, cause.messageKey, cause.params) || cause.message
    : t('errors.generic' as never);
}
