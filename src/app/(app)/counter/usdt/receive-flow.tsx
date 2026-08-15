'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, ExternalLink, Inbox, Loader2, MessageCircle, RefreshCw } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { QrCode } from '@/core/qr/qr-code';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';

/**
 * Taking USDT at the window: the address, then the log of what actually landed.
 *
 * ## Why there is no amount to type
 *
 * Asking the teller to type what the customer says they sent turns a fact into
 * a claim and then searches for it. Two customers sending the same round number
 * are then indistinguishable by the only thing the search knows, and a week of
 * unclaimed transfers for that number all answer at once.
 *
 * The chain already keeps a chronological record of everything that reached the
 * address. So this shows that record instead: newest first, with the time, the
 * sender and the hash. The customer sent four minutes ago; their transfer is at
 * the top. Nobody types anything and nothing has to be matched.
 *
 * ## Why every row opens the explorer
 *
 * Because the office's word for what arrived should not be the only word
 * available. A teller who can put the transfer on TronScan next to the
 * customer's own wallet has settled the question in front of them, in the one
 * place neither of them controls. It is also the answer to "are you sure it
 * arrived?" that does not require the customer to trust this screen.
 *
 * ## Where it still refuses
 *
 * Priced at the board when it is recorded, because nothing was promised
 * earlier. A transfer that has not reached its confirmations is shown — the
 * customer is standing there and "it is coming" beats an empty list — but it
 * cannot be paid.
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

interface Arrival {
  id: string;
  txHash: string;
  amount: string;
  confirmations: number;
  required: number;
  ready: boolean;
  firstSeenAt: string;
  fromAddress: string | null;
  explorerUrl: string;
  wallet: { id: string; label: string; labelAr: string; network: string; tokenSymbol: string };
}

/** How often the log refreshes itself while a customer is waiting. */
const POLL_MS = 15_000;

export function ReceiveFlow({
  addresses,
  currencies,
  companyName,
  permissions,
}: {
  addresses: CounterAddress[];
  currencies: { code: string; nameEn: string; nameAr: string; decimals: number }[];
  /** Put at the head of an address sent out, so it does not arrive anonymous. */
  companyName: string;
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [walletId, setWalletId] = useState(addresses[0]?.id ?? '');
  const [arrivals, setArrivals] = useState<Arrival[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [chosen, setChosen] = useState<Arrival | null>(null);
  const [payoutCurrency, setPayoutCurrency] = useState(currencies[0]?.code ?? 'ILS');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [counterpartyName, setCounterpartyName] = useState('');
  const [quote, setQuote] = useState<{ toAmount: string } | null>(null);
  const [recording, setRecording] = useState(false);
  const [done, setDone] = useState<{ reference: string } | null>(null);

  const wallet = addresses.find((entry) => entry.id === walletId);

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      setArrivals(await api.get<Arrival[]>('/api/usdt/arrivals'));
    } catch {
      // A log that shouts about a provider outage would shout all day.
      setArrivals((current) => current ?? []);
    } finally {
      if (manual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Priced when a row is chosen, and again if the currency changes under it.
  useEffect(() => {
    if (!chosen) return;
    let current = true;
    setQuote(null);
    void api
      .get<{ toAmount: string }>(`/api/usdt/arrivals/${chosen.id}?payoutCurrency=${payoutCurrency}`)
      .then((result) => {
        if (current) setQuote(result);
      })
      .catch(() => {
        if (current) setQuote(null);
      });
    return () => {
      current = false;
    };
  }, [chosen, payoutCurrency]);

  const record = async () => {
    if (!chosen) return;
    setRecording(true);
    try {
      const created = await api.post<{ id: string; reference: string }>(
        `/api/usdt/arrivals/${chosen.id}`,
        {
          payoutCurrency,
          customerId: customer?.id ?? null,
          counterpartyName: counterpartyName.trim() || null,
        },
      );
      toast.success(t('receive.recorded'), created.reference);
      setDone(created);
      setChosen(null);
      setCustomer(null);
      setCounterpartyName('');
      await load();
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
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ============ The address, shown before anything is asked ========= */}
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
                {/* Getting the network wrong destroys the money with no
                    recourse from anyone. It is the loudest thing here. */}
                <div className="rounded-[var(--radius-control)] border-2 border-warning bg-warning-subtle p-3 text-center">
                  <p className="text-xs font-medium uppercase tracking-wide text-content-secondary">
                    {t('counter.networkWarningLabel')}
                  </p>
                  <p className="mt-1 text-2xl font-bold text-content ltr-content">
                    {wallet.network}
                  </p>
                  <p className="mt-1 text-xs text-content-secondary">
                    {t('counter.networkWarningBody')}
                  </p>
                </div>

                <div className="flex justify-center">
                  <QrCode value={wallet.address} size={220} title={wallet.address} />
                </div>

                <AddressBlock
                  address={wallet.address}
                  network={wallet.network}
                  companyName={companyName}
                  onCopy={() => toast.success(t('common.copied'))}
                />
              </>
            )}
          </CardBody>
        </Card>

        {/* ============ The log of what actually landed ===================== */}
        <Card>
          <CardHeader
            title={t('receive.logTitle')}
            description={t('receive.logBody')}
            actions={
              <Button
                size="sm"
                variant="ghost"
                icon={refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                onClick={() => void load(true)}
              >
                {t('common.refresh')}
              </Button>
            }
          />
          <CardBody className="space-y-3">
            {done && (
              <Alert tone="success" icon={<Check />} title={t('receive.recorded')}>
                <span className="font-mono ltr-content">{done.reference}</span>
              </Alert>
            )}

            {arrivals === null ? (
              <div className="flex justify-center py-8">
                <Loader2 className="size-5 animate-spin text-content-tertiary" />
              </div>
            ) : arrivals.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Inbox className="size-8 text-content-tertiary" />
                <p className="text-sm text-content-secondary">{t('receive.logEmpty')}</p>
              </div>
            ) : (
              <ul className="divide-border-subtle divide-y">
                {arrivals.map((arrival) => (
                  <li key={arrival.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="text-lg font-bold text-content tabular-nums">
                        <Money value={arrival.amount} currency={arrival.wallet.tokenSymbol} />
                      </span>
                      {/*
                        When, in the form the teller actually needs: "four
                        minutes ago" answers "is this the man in front of me",
                        and a date does not.
                      */}
                      <span className="text-sm font-medium text-content-secondary">
                        <DateText value={arrival.firstSeenAt} relative />
                      </span>
                      <span className="text-xs text-content-tertiary">
                        <DateText value={arrival.firstSeenAt} withTime />
                      </span>
                      {!arrival.ready && (
                        <Badge tone="warning">
                          {t('arrivals.confirming', {
                            confirmations: arrival.confirmations,
                            required: arrival.required,
                          })}
                        </Badge>
                      )}
                    </div>

                    {arrival.fromAddress && (
                      <p className="text-xs text-content-tertiary">
                        {t('receive.from')}{' '}
                        <span className="font-mono ltr-content">{arrival.fromAddress}</span>
                      </p>
                    )}

                    <p className="break-all font-mono text-[11px] text-content-tertiary ltr-content">
                      {arrival.txHash}
                    </p>

                    <div className="flex flex-wrap items-center gap-2">
                      {/*
                        The public record, one press away. Neither the office nor
                        the customer owns TronScan, which is exactly why it
                        settles the argument.
                      */}
                      <a
                        href={arrival.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-border-base px-3 text-sm text-content-secondary transition-colors hover:border-primary hover:text-primary-text"
                      >
                        <ExternalLink className="size-4" />
                        {t('receive.openExplorer')}
                      </a>

                      {arrival.ready && (
                        <Button size="sm" onClick={() => setChosen(arrival)} className="ms-auto">
                          {t('receive.record')}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ============ Recording the one the teller picked ================== */}
      <Dialog
        open={chosen !== null}
        onClose={() => setChosen(null)}
        title={t('receive.recordTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setChosen(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void record()} loading={recording} disabled={!quote}>
              {t('receive.record')}
            </Button>
          </>
        }
      >
        {chosen && (
          <div className="space-y-3">
            <Alert tone="neutral">{t('arrivals.pricedNow')}</Alert>

            <div className="flex items-center justify-between rounded-xl bg-surface-sunken px-3 py-2">
              <span className="text-sm text-content-secondary">{t('arrivals.arrived')}</span>
              <span className="font-semibold tabular-nums">
                <Money value={chosen.amount} currency={chosen.wallet.tokenSymbol} />
              </span>
            </div>

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

            <div className="flex items-center justify-between rounded-xl bg-primary-subtle px-3 py-2">
              <span className="text-sm text-content-secondary">{t('arrivals.payout')}</span>
              {quote ? (
                <span className="text-lg font-bold tabular-nums">
                  <Money value={quote.toAmount} currency={payoutCurrency} />
                </span>
              ) : (
                <Loader2 className="size-4 animate-spin text-content-tertiary" />
              )}
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
          </div>
        )}
      </Dialog>
    </>
  );
}

/**
 * The address, split so a human can actually verify it against a phone — and
 * two ways to get it into theirs.
 *
 * ## Why sending it matters more than copying it
 *
 * Copying works when the customer is holding the same device. They are not:
 * they are looking at this screen and typing into their own phone, and a
 * thirty-four character address typed by hand is the single easiest way to lose
 * the money — one wrong character and it goes somewhere nobody can reach.
 *
 * The QR solves that for a customer whose wallet can scan. WhatsApp solves it
 * for everybody else, and for the customer who is not in the room at all. The
 * message carries the network warning with the address, because an address on
 * its own in a chat window is exactly the thing that gets pasted into the wrong
 * chain three days later.
 */
export function AddressBlock({
  address,
  network,
  companyName,
  onCopy,
}: {
  address: string;
  network?: string;
  companyName?: string;
  onCopy: () => void;
}) {
  const { t } = useLocale();
  const head = address.slice(0, 6);
  const tail = address.slice(-6);
  const middle = address.slice(6, -6);

  const message = [
    companyName,
    '',
    t('receive.shareHeading', { network: network ?? '' }),
    address,
    '',
    t('receive.shareWarning', { network: network ?? '' }),
  ]
    .filter((line) => line !== undefined)
    .join('\n');

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

      {network && (
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border-base text-sm text-content-secondary transition-colors hover:border-success hover:text-success-text"
        >
          <MessageCircle className="h-4 w-4" />
          {t('receive.shareAddress')}
        </a>
      )}
    </div>
  );
}
