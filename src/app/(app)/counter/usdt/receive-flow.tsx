'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Copy, Loader2, Search, Wallet } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { QrCode } from '@/core/qr/qr-code';
import { Alert, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput, Select } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';

/**
 * Taking USDT at the window, in the order the window actually works.
 *
 * ## The sequence
 *
 * Pick the address and it is on the screen — code, address, network — with
 * nothing declared and nothing reserved. The customer scans and sends. The
 * teller types **what arrived**, asks the chain, and records.
 *
 * That is the whole flow, and its virtue is that no step commits the office to
 * anything before the money exists. The old order asked for a figure, a reserved
 * amount and a countdown before the customer had touched their phone, and every
 * one of those had to be reconciled afterwards against what really happened.
 * Customers do not wait for paperwork; they scan the code the moment they see
 * it.
 *
 * ## Priced at the end, not the beginning
 *
 * Nothing was promised in advance, so there is nothing to honour: the payout is
 * the board at the moment the transfer is confirmed and the teller is standing
 * there. The office carries no rate exposure between a quote and an arrival,
 * because there is no gap between them any more.
 *
 * ## Where it refuses
 *
 * Exactly one unclaimed transfer for that figure is a settlement. Two is not a
 * near miss to be resolved by picking the newer one — both are shown, with the
 * sender, the time and the hash, and the teller chooses. Nothing here guesses
 * which customer is which.
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

type Search =
  | { state: 'NONE' }
  | { state: 'UNCONFIRMED'; confirmations: number; required: number; txHash: string }
  | {
      state: 'FOUND';
      arrival: {
        id: string;
        txHash: string;
        amount: string;
        confirmations: number;
        firstSeenAt: string;
        fromAddress: string | null;
      };
      quote: { toAmount: string; rate: string; payoutCurrency: string };
    }
  | {
      state: 'AMBIGUOUS';
      candidates: {
        id: string;
        txHash: string;
        amount: string;
        firstSeenAt: string;
        fromAddress: string | null;
      }[];
    };

export function ReceiveFlow({
  addresses,
  currencies,
  permissions,
}: {
  addresses: CounterAddress[];
  currencies: { code: string; nameEn: string; nameAr: string; decimals: number }[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [walletId, setWalletId] = useState(addresses[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [payoutCurrency, setPayoutCurrency] = useState(currencies[0]?.code ?? 'ILS');

  const [found, setFound] = useState<Search | null>(null);
  const [checking, setChecking] = useState(false);

  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [counterpartyName, setCounterpartyName] = useState('');
  const [recording, setRecording] = useState(false);
  const [done, setDone] = useState<{ reference: string } | null>(null);

  const wallet = addresses.find((entry) => entry.id === walletId);

  /*
   * A previous answer belongs to a previous question, so changing the address,
   * the figure or the currency clears the verdict under them.
   *
   * The confirmation of a completed transaction is deliberately not cleared
   * here. Recording empties the amount field, which would fire this and wipe
   * the reference the moment it appeared — the one thing the teller needs to
   * still be on screen while they count the cash out.
   */
  useEffect(() => {
    setFound(null);
  }, [walletId, amount, payoutCurrency]);

  const verify = async () => {
    if (!wallet || !amount.trim()) return;
    // The previous customer's receipt makes way for this one's question.
    setDone(null);
    setChecking(true);
    try {
      setFound(
        await api.post<Search>('/api/usdt/arrivals/verify', {
          walletId: wallet.id,
          amount: amount.trim(),
          payoutCurrency,
        }),
      );
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
      setFound(null);
    } finally {
      setChecking(false);
    }
  };

  const record = async (chainTransactionId: string) => {
    setRecording(true);
    try {
      const created = await api.post<{ id: string; reference: string }>(
        `/api/usdt/arrivals/${chainTransactionId}`,
        {
          payoutCurrency,
          customerId: customer?.id ?? null,
          counterpartyName: counterpartyName.trim() || null,
        },
      );
      toast.success(t('receive.recorded'), created.reference);
      setDone(created);
      setFound(null);
      setAmount('');
      setCustomer(null);
      setCounterpartyName('');
      router.refresh();
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setRecording(false);
    }
  };

  if (addresses.length === 0) return null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* ============ 1. The address, before anything is asked for ========== */}
      <Card>
        <CardHeader title={t('receive.addressTitle')} description={t('receive.addressBody')} />
        <CardBody className="space-y-4">
          <Field label={t('counter.address')} required>
            {(props) => (
              <Select
                {...props}
                value={walletId}
                onChange={(event) => setWalletId(event.target.value)}
                options={addresses.map((entry) => ({
                  value: entry.id,
                  label: `${ln(entry, 'label')} — ${entry.network}`,
                }))}
              />
            )}
          </Field>

          {wallet && !wallet.drawerId && (
            <Alert tone="warning">{t('counter.walletNotLinked')}</Alert>
          )}

          {wallet && (
            <>
              {/* Getting the network wrong destroys the money with no recourse
                  from anyone. It is the loudest thing on the screen. */}
              <div className="rounded-[var(--radius-control)] border-2 border-warning bg-warning-subtle p-3 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-content-secondary">
                  {t('counter.networkWarningLabel')}
                </p>
                <p className="mt-1 text-2xl font-bold text-content ltr-content">{wallet.network}</p>
                <p className="mt-1 text-xs text-content-secondary">
                  {t('counter.networkWarningBody')}
                </p>
              </div>

              <div className="flex justify-center">
                <QrCode value={wallet.address} size={220} title={wallet.address} />
              </div>

              <AddressBlock
                address={wallet.address}
                onCopy={() => toast.success(t('common.copied'))}
              />
            </>
          )}
        </CardBody>
      </Card>

      {/* ============ 2. What arrived, and whether it is really there ======= */}
      <Card>
        <CardHeader title={t('receive.verifyTitle')} description={t('receive.verifyBody')} />
        <CardBody className="space-y-3">
          <Field label={t('receive.amountArrived')} required>
            {(props) => (
              <MoneyInput
                {...props}
                value={amount}
                onValueChange={setAmount}
                currency={wallet?.tokenSymbol ?? 'USDT'}
              />
            )}
          </Field>

          <Field label={t('counter.payoutCurrency')} required>
            {(props) => (
              <Select
                {...props}
                value={payoutCurrency}
                onChange={(event) => setPayoutCurrency(event.target.value)}
                options={currencies.map((currency) => ({
                  value: currency.code,
                  label: `${ln(currency, 'name')} (${currency.code})`,
                }))}
              />
            )}
          </Field>

          <Button
            fullWidth
            icon={checking ? <Loader2 className="animate-spin" /> : <Search />}
            onClick={() => void verify()}
            loading={checking}
            disabled={!wallet || !amount.trim()}
          >
            {t('receive.verify')}
          </Button>

          {done && (
            <Alert tone="success" icon={<Check />} title={t('receive.recorded')}>
              <span className="font-mono ltr-content">{done.reference}</span>
            </Alert>
          )}

          {found?.state === 'NONE' && (
            <Alert tone="neutral" icon={<Wallet />} title={t('receive.notYetTitle')}>
              {t('receive.notYetBody')}
            </Alert>
          )}

          {found?.state === 'UNCONFIRMED' && (
            <Alert tone="warning" icon={<Loader2 className="animate-spin" />} title={t('receive.settlingTitle')}>
              <p className="text-sm">
                {t('receive.settlingBody', {
                  confirmations: String(found.confirmations),
                  required: String(found.required),
                })}
              </p>
              <span className="mt-1 block break-all font-mono text-xs ltr-content">
                {found.txHash}
              </span>
            </Alert>
          )}

          {found?.state === 'AMBIGUOUS' && (
            <Alert tone="warning" icon={<AlertTriangle />} title={t('counter.ambiguousTitle')}>
              <p className="mb-2 text-sm">{t('receive.ambiguousBody')}</p>
              <ul className="space-y-1">
                {found.candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      onClick={() => void record(candidate.id)}
                      disabled={recording}
                      className="w-full rounded-[var(--radius-control)] border border-border-base px-2 py-2 text-start transition-colors hover:border-primary disabled:opacity-50"
                    >
                      <span className="block break-all font-mono text-xs ltr-content">
                        {candidate.txHash}
                      </span>
                      <span className="text-xs text-content-secondary">
                        <DateText value={candidate.firstSeenAt} withTime />
                        {candidate.fromAddress && (
                          <span className="ms-2 font-mono ltr-content">
                            {candidate.fromAddress.slice(0, 10)}…
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          {found?.state === 'FOUND' && (
            <div className="space-y-3 rounded-2xl bg-success-subtle p-3 ring-1 ring-success-border">
              <p className="flex items-center gap-2 text-sm font-semibold text-content">
                <Check className="size-4 text-success" />
                {t('receive.foundTitle')}
              </p>

              {/* The proof, in the form a person can check against the customer's
                  own wallet: the hash, when it landed, and who sent it. */}
              <dl className="space-y-1 text-sm">
                <Row label={t('arrivals.arrived')}>
                  <Money value={found.arrival.amount} currency={wallet?.tokenSymbol ?? 'USDT'} />
                </Row>
                <Row label={t('receive.seenAt')}>
                  <DateText value={found.arrival.firstSeenAt} withTime />
                </Row>
                <Row label={t('receive.confirmations')}>
                  <span className="tabular-nums">{found.arrival.confirmations}</span>
                </Row>
              </dl>

              <span className="block break-all font-mono text-xs text-content-tertiary ltr-content">
                {found.arrival.txHash}
              </span>

              <div className="flex items-center justify-between rounded-xl bg-surface px-3 py-2">
                <span className="text-sm text-content-secondary">{t('arrivals.payout')}</span>
                <span className="text-lg font-bold tabular-nums">
                  <Money value={found.quote.toAmount} currency={found.quote.payoutCurrency} />
                </span>
              </div>

              <CustomerPicker
                value={customer}
                onChange={setCustomer}
                permissions={permissions}
              />

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

              <Button
                fullWidth
                onClick={() => void record(found.arrival.id)}
                loading={recording}
              >
                {t('receive.record')}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-content-secondary">{label}</dt>
      <dd className="font-medium text-content">{children}</dd>
    </div>
  );
}

/** The address, split so a human can actually verify it against a phone. */
export function AddressBlock({ address, onCopy }: { address: string; onCopy: () => void }) {
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
        className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border-base text-sm text-content-secondary transition-colors hover:border-primary hover:text-primary-text"
      >
        <Copy className="h-4 w-4" />
        {t('counter.copyAddress', { length: String(address.length) })}
      </button>
    </div>
  );
}
