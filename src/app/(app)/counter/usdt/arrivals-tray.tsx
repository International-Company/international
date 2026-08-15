'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banknote, Clock, Inbox, Loader2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';

/**
 * Money that arrived before anybody asked it to.
 *
 * ## The case this exists for
 *
 * The request flow next to this one assumes the teller opens a request and the
 * customer then sends. Plenty of customers do it the other way round — they
 * send from the taxi, or before they walk in, or while the teller is still
 * finding the address. Under a request-first design each of those is a failure:
 * nothing matches, and the money lands on the address and is seen by nobody.
 *
 * So this is the same work approached from the other end. The money is already
 * here; what is missing is only whose it is and what they are owed.
 *
 * ## Why it is silent when empty
 *
 * Most of the day there is nothing waiting, and a permanent empty box teaches
 * the eye to skip the place where the unusual thing will appear. It shows up
 * only when there is something in it, at the top, above the request form —
 * because money already at the door outranks money that might arrive.
 *
 * ## Why the figure is asked of the server
 *
 * A teller does not hold the rate board, deliberately. The counter has always
 * priced on the server inside the counter permission, and this does the same:
 * the teller learns the figure they are about to read aloud without being
 * handed the board.
 */

interface Arrival {
  id: string;
  txHash: string;
  amount: string;
  confirmations: number;
  required: number;
  ready: boolean;
  firstSeenAt: string;
  fromAddress: string | null;
  wallet: { id: string; label: string; labelAr: string; network: string; tokenSymbol: string };
}

/** How often the tray asks. The server polls the chain on its side. */
const POLL_MS = 20_000;

export function ArrivalsTray({
  currencies,
  permissions,
}: {
  currencies: { code: string; nameEn: string; nameAr: string; decimals: number }[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [arrivals, setArrivals] = useState<Arrival[] | null>(null);
  const [chosen, setChosen] = useState<Arrival | null>(null);

  const [payoutCurrency, setPayoutCurrency] = useState(currencies[0]?.code ?? 'ILS');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [counterpartyName, setCounterpartyName] = useState('');
  const [quote, setQuote] = useState<{ toAmount: string; rate: string } | null>(null);
  const [settling, setSettling] = useState(false);

  const allowed = permissions.includes('usdt.counter.use');

  const load = useCallback(async () => {
    if (!allowed) return;
    try {
      setArrivals(await api.get<Arrival[]>('/api/usdt/arrivals'));
    } catch {
      // A tray that shouts about a provider outage would be shouting all day.
      setArrivals((current) => current ?? []);
    }
  }, [allowed]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Priced whenever the arrival or the currency changes, so the teller never
  // reads a figure that belongs to the previous selection.
  useEffect(() => {
    if (!chosen) return;
    let current = true;
    setQuote(null);
    void api
      .get<{ toAmount: string; rate: string }>(
        `/api/usdt/arrivals/${chosen.id}?payoutCurrency=${payoutCurrency}`,
      )
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

  const open = (arrival: Arrival) => {
    setChosen(arrival);
    setCustomer(null);
    setCounterpartyName('');
  };

  const settle = async () => {
    if (!chosen) return;
    setSettling(true);
    try {
      const created = await api.post<{ id: string; reference: string }>(
        `/api/usdt/arrivals/${chosen.id}`,
        {
          payoutCurrency,
          customerId: customer?.id ?? null,
          counterpartyName: counterpartyName.trim() || null,
        },
      );
      toast.success(t('arrivals.settled'), created.reference);
      setChosen(null);
      await load();
      router.refresh();
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setSettling(false);
    }
  };

  if (!allowed || arrivals === null || arrivals.length === 0) return null;

  return (
    <>
      <Card className="border-warning-border">
        <CardHeader
          title={t('arrivals.title')}
          description={t('arrivals.subtitle', { count: arrivals.length })}
        />
        <CardBody className="space-y-2">
          <ul className="divide-border-subtle divide-y">
            {arrivals.map((arrival) => (
              <li key={arrival.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <Inbox className="size-4 shrink-0 text-content-tertiary" />

                <span className="text-base font-semibold text-content ltr-content tabular-nums">
                  <Money value={arrival.amount} currency={arrival.wallet.tokenSymbol} />
                </span>

                <span className="text-xs text-content-tertiary">
                  {ln(arrival.wallet, 'label')} · {arrival.wallet.network}
                </span>

                <span className="flex items-center gap-1 text-xs text-content-tertiary">
                  <Clock className="size-3.5" />
                  <DateText value={arrival.firstSeenAt} withTime />
                </span>

                {/*
                  A transfer still settling on the chain is shown rather than
                  hidden — the customer is standing there and "it is coming" is
                  a better answer than an empty list — but it cannot be paid.
                */}
                {arrival.ready ? (
                  <Button
                    size="sm"
                    icon={<Banknote />}
                    onClick={() => open(arrival)}
                    className="ms-auto"
                  >
                    {t('arrivals.settle')}
                  </Button>
                ) : (
                  <Badge tone="warning" className="ms-auto">
                    {t('arrivals.confirming', {
                      confirmations: arrival.confirmations,
                      required: arrival.required,
                    })}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Dialog
        open={chosen !== null}
        onClose={() => setChosen(null)}
        title={t('arrivals.settleTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setChosen(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void settle()} loading={settling} disabled={!quote}>
              {t('arrivals.settle')}
            </Button>
          </>
        }
      >
        {chosen && (
          <div className="space-y-3">
            <Alert tone="neutral">
              {t('arrivals.pricedNow')}
            </Alert>

            <div className="flex items-center justify-between rounded-xl bg-surface-sunken px-3 py-2">
              <span className="text-sm text-content-secondary">{t('arrivals.arrived')}</span>
              <span className="font-semibold ltr-content tabular-nums">
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
                <span className="text-lg font-bold ltr-content tabular-nums">
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
