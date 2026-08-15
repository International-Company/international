'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  Ban,
  Check,
  Clock,
  Copy,
  Loader2,
  Plus,
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
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput, Select, Textarea } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';
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
  | { state: 'AMBIGUOUS'; candidates: { id: string; txHash: string; amount: string; seenAt: string }[] };

export function CounterView({
  addresses,
  openRequests,
  currencies,
  windowMinutes,
  permissions,
}: {
  addresses: CounterAddress[];
  openRequests: OpenRequest[];
  currencies: { code: string; nameEn: string; nameAr: string; decimals: number }[];
  windowMinutes: number;
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [walletId, setWalletId] = useState(addresses[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [payoutCurrency, setPayoutCurrency] = useState(currencies[0]?.code ?? 'ILS');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [counterpartyName, setCounterpartyName] = useState('');
  const [notes, setNotes] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [opening, setOpening] = useState(false);

  const [active, setActive] = useState<OpenRequest | null>(openRequests[0] ?? null);
  const [outcome, setOutcome] = useState<MatchOutcome | null>(null);
  const [checking, setChecking] = useState(false);
  const [settling, setSettling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const wallet = useMemo(
    () => addresses.find((entry) => entry.id === (active?.id ? undefined : walletId)) ?? addresses.find((entry) => entry.address === active?.address) ?? addresses[0],
    [addresses, walletId, active],
  );

  const open = async () => {
    setOpening(true);
    try {
      const created = await api.post<OpenRequest>('/api/usdt/counter', {
        walletId,
        amount: amount.trim(),
        payoutCurrency,
        customerId: customer?.id ?? null,
        counterpartyName: counterpartyName.trim() || null,
        notes: notes.trim() || null,
      });

      setActive({
        ...created,
        createdAt: new Date().toISOString(),
        wallet: {
          label: wallet?.label ?? '',
          labelAr: wallet?.labelAr ?? '',
          network: created.network,
        },
        customer: customer
          ? {
              id: customer.id,
              code: customer.code,
              fullNameEn: customer.fullNameEn,
              fullNameAr: customer.fullNameAr,
            }
          : null,
        transaction: null,
        matchedChainTransaction: null,
        counterpartyName: counterpartyName.trim() || null,
      });
      setOutcome(null);
      setAmount('');
      router.refresh();
    } catch (cause) {
      toast.error(t('errors.title'), message(cause, t));
    } finally {
      setOpening(false);
    }
  };

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

  const attach = async (chainTransactionId: string) => {
    if (!active) return;
    try {
      await api.post(`/api/usdt/counter/${active.id}`, { action: 'attach', chainTransactionId });
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

  const selected = addresses.find((entry) => entry.id === walletId);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* --- Teller: open a request -------------------------------------- */}
      <Card>
        <CardHeader title={t('counter.newRequest')} />
        <CardBody className="space-y-3">
          <Field label={t('counter.address')} required>
            {(props) => (
              <Select
                {...props}
                value={walletId}
                onChange={(event) => setWalletId(event.target.value)}
                disabled={Boolean(active && active.status !== 'COMPLETED')}
                options={addresses.map((entry) => ({
                  value: entry.id,
                  label: `${ln(entry, 'label')} — ${entry.network}`,
                }))}
              />
            )}
          </Field>

          {selected && !selected.drawerId && (
            <Alert tone="warning">{t('counter.walletNotLinked')}</Alert>
          )}
          {selected && !selected.isAutomatic && (
            <Alert tone="neutral">{t('counter.manualNetwork')}</Alert>
          )}

          <Field label={t('counter.amountExpected')} required>
            {(props) => (
              <MoneyInput
                {...props}
                value={amount}
                onValueChange={setAmount}
                currency="USDT"
                disabled={Boolean(active && active.status !== 'COMPLETED')}
              />
            )}
          </Field>

          <Field label={t('counter.payoutCurrency')} required>
            {(props) => (
              <Select
                {...props}
                value={payoutCurrency}
                onChange={(event) => setPayoutCurrency(event.target.value)}
                disabled={Boolean(active && active.status !== 'COMPLETED')}
                options={currencies.map((currency) => ({
                  value: currency.code,
                  label: `${ln(currency, 'name')} (${currency.code})`,
                }))}
              />
            )}
          </Field>

          {/*
            Who it is for, and anything worth noting — folded away.
            Three fields none of which is required stood permanently between the
            teller and the button they came to press. Opening a request needs an
            address, an amount and a payout currency; the rest is for the
            occasions that call for it, and says so by staying shut.
          */}
          {detailsOpen || customer ? (
            <div className="space-y-3 rounded-[var(--radius-control)] bg-surface-sunken p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-content">{t('counter.aboutCustomer')}</p>
                <button
                  type="button"
                  onClick={() => {
                    setDetailsOpen(false);
                    setCustomer(null);
                    setCounterpartyName('');
                    setNotes('');
                  }}
                  aria-label={t('common.close')}
                  className="flex size-8 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-hover hover:text-content"
                >
                  <X className="size-4" />
                </button>
              </div>

              <CustomerPicker value={customer} onChange={setCustomer} permissions={permissions} />

              {!customer && (
                <Field label={t('transactions.counterpartyName')}>
                  {(props) => (
                    <Input
                      {...props}
                      value={counterpartyName}
                      onChange={(event) => setCounterpartyName(event.target.value)}
                    />
                  )}
                </Field>
              )}

              <Field label={t('common.notes')}>
                {(props) => (
                  <Textarea
                    {...props}
                    rows={2}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                )}
              </Field>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setDetailsOpen(true)}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-dashed border-border-base text-sm text-content-tertiary transition-colors hover:border-primary hover:text-primary-text"
            >
              <Plus className="size-4" />
              {t('counter.aboutCustomer')}
            </button>
          )}

          <Button
            variant="primary"
            fullWidth
            icon={<Wallet />}
            loading={opening}
            disabled={!walletId || !amount.trim() || Boolean(active && active.status !== 'COMPLETED')}
            onClick={() => void open()}
          >
            {t('counter.open')}
          </Button>

          <p className="text-xs text-content-secondary">
            {t('counter.windowHint', { minutes: String(windowMinutes) })}
          </p>
        </CardBody>
      </Card>

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
      ) : (
        <Card>
          <CardBody className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
            <Wallet className="h-8 w-8 text-content-tertiary" />
            <p className="text-sm text-content-secondary">{t('counter.emptyBody')}</p>
          </CardBody>
        </Card>
      )}

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
}: {
  outcome: MatchOutcome | null;
  status: string;
  onAttach: (chainTransactionId: string) => void;
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
