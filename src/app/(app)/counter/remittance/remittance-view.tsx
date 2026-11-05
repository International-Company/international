'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ClipboardPen,
  Check,
  Loader2,
  Printer,
  RotateCcw,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { normalizeDigits } from '@/core/money/money';
import { api, ApiError, queryString } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button } from '@/ui/primitives';
import { ShareButton } from '@/ui/share';
import { AutoPrintToggle, printAfterRecording } from '@/ui/auto-print';
import { useToast } from '@/ui/overlay';
import { Field, Input } from '@/ui/form';
import { cn } from '@/ui/utils';
import { PhotoField } from '@/ui/photo-field';
import { priceRemittance, type FeeKind } from '@/modules/exchange/remittance-pricing';
import { RemittancePrices, type PriceRow } from './remittance-prices';
import { UnpricedRemittances } from './remittance-unpriced';

/**
 * The remittance tool.
 *
 * A remittance is not a conversion, so this is deliberately not the exchange
 * card wearing a different label. There is one currency and two figures, and
 * the whole commercial content of the transaction is the gap between them: what
 * the customer settles, and what the correspondent's price list charges.
 *
 * Both figures are typed. The commission takes several forms depending on the
 * destination and the size — a flat fee, a percentage, sometimes only a worse
 * rate — and a screen that insisted on one formula would be wrong for most of
 * them. So the branch's earning is shown as a consequence of the two numbers
 * rather than as a third field to reconcile.
 *
 * There is no pending state. The correspondent takes the money and is the one
 * obliged to deliver it; the branch has nothing left to wait on, and a status
 * that only ever had one value would be a box nobody would ever tick.
 */

interface Currency {
  code: string;
  nameEn: string;
  nameAr: string;
  symbol: string;
  decimals: number;
}

interface Config {
  destinations: string[];
  transferChannels: string[];
  prices: PriceRow[];
  currencies: Currency[];
}

interface RecentRow {
  id: string;
  reference: string;
  type: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  createdAt: string;
}

type Direction = 'OUT' | 'IN';

export function RemittanceView({
  config,
  permissions,
}: {
  config: Config;
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [direction, setDirection] = useState<Direction>('OUT');
  /** Only writing down what was taken, rather than a whole remittance. */
  const [quick, setQuick] = useState(false);
  const [currency, setCurrency] = useState(config.currencies[0]?.code ?? 'ILS');
  const [destination, setDestination] = useState(config.destinations[0] ?? '');

  /*
   * The two figures, in the order the counter meets them.
   *
   * Sending, the customer's total comes first and the correspondent's price
   * second. Receiving, the correspondent's credit comes first and what is
   * counted out to the customer second. Either way the first is the larger and
   * the branch keeps the difference, which is why one pair of fields serves
   * both directions instead of four.
   */
  const [gross, setGross] = useState('');
  const [net, setNet] = useState('');

  /*
   * The sum being sent, when the destination has a price. The two figures below
   * are worked out from it, and stay open: the deal in front of the teller can
   * always differ from the list.
   */
  const [sum, setSum] = useState('');
  /** How the customer pays: notes across the counter, or a transfer to an office account. */
  const [paidVia, setPaidVia] = useState<'CASH' | 'TRANSFER'>('CASH');
  const [intakeChannel, setIntakeChannel] = useState(config.transferChannels[0] ?? '');
  /** What reaches the beneficiary, and the word for its money. For showing only. */
  const [delivered, setDelivered] = useState('');
  const [deliveredUnit, setDeliveredUnit] = useState('جنيه');
  /** A photo of what the customer paid, shrunk and ready to send. */
  const [proof, setProof] = useState<string | null>(null);
  /** A photo of who the remittance is for. */
  const [beneficiaryPhoto, setBeneficiaryPhoto] = useState<string | null>(null);

  const [counterpartyName, setCounterpartyName] = useState('');
  const [counterpartyPhone, setCounterpartyPhone] = useState('');
  const [notes, setNotes] = useState('');

  const [posting, setPosting] = useState(false);
  const [done, setDone] = useState<{ id: string; reference: string } | null>(null);
  const [recent, setRecent] = useState<RecentRow[]>([]);

  const grossRef = useRef<HTMLInputElement>(null);

  const selected = config.currencies.find((entry) => entry.code === currency);
  const decimals = selected?.decimals ?? 2;

  const grossValue = scaleAmount(gross);
  const netValue = scaleAmount(net);
  const margin = grossValue - netValue;

  const outgoing = direction === 'OUT';
  const byTransfer = outgoing && paidVia === 'TRANSFER';
  const nameRequired = !outgoing;
  const canSeeMargin = permissions.includes('exchange.margin.view');

  // The teller's own last few, in the direction they are working in — a lost
  // receipt is asked for at the counter, with the next customer already waiting.
  const loadRecent = useCallback(async () => {
    try {
      setRecent(
        await api.get<RecentRow[]>(
          `/api/manage/transactions${queryString({
            recent: true,
            type: direction === 'OUT' ? 'REMITTANCE_OUT' : 'REMITTANCE_IN',
            pageSize: 4,
          })}`,
        ),
      );
    } catch {
      setRecent([]);
    }
  }, [direction]);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const reset = () => {
    setGross('');
    setNet('');
    setSum('');
    setDelivered('');
    setProof(null);
    setBeneficiaryPhoto(null);
    setPaidVia('CASH');
    setCounterpartyName('');
    setCounterpartyPhone('');
    setNotes('');
    setDone(null);
    grossRef.current?.focus();
  };

  /*
   * Everything standing in the way, checked here so the teller is told before
   * the customer is quoted. The server checks all of it again — this is the
   * courteous version, not the trusted one.
   */
  const blocked =
    !destination ||
    grossValue <= 0n ||
    // Sending, the correspondent's price can follow once it is known.
    (!outgoing && netValue <= 0n) ||
    (netValue > 0n && margin < 0n) ||
    // A name is asked for where someone answers for the money: a remittance paid out here.
    (nameRequired && !counterpartyName.trim()) ||
    // A transfer belongs to someone who can be reached; the server insists too.
    (byTransfer && !counterpartyPhone.trim());

  const submit = async () => {
    if (blocked) return;
    setPosting(true);
    try {
      const result = await api.post<{ id: string; reference: string }>('/api/exchange/remittance', {
        direction,
        currency,
        destination,
        gross: unscale(grossValue),
        net: netValue > 0n ? unscale(netValue) : null,
        delivered: outgoing && delivered ? delivered : null,
        deliveredUnit: outgoing && delivered ? deliveredUnit.trim() : null,
        counterpartyName: counterpartyName.trim() || null,
        counterpartyPhone: counterpartyPhone.trim() || null,
        notes: notes.trim() || null,
        intakeChannel: byTransfer ? intakeChannel : null,
        proof: outgoing ? proof : null,
        beneficiary: outgoing ? beneficiaryPhoto : null,
      });

      toast.success(t('remittance.recorded'), result.reference);
      printAfterRecording(result.id, permissions);
      setDone(result);
      setGross('');
      setNet('');
      setSum('');
      setDelivered('');
      setProof(null);
      setBeneficiaryPhoto(null);
      setPaidVia('CASH');
      setCounterpartyName('');
      setCounterpartyPhone('');
      setNotes('');
      void loadRecent();
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setPosting(false);
    }
  };

  const print = (id: string) => window.open(`/print/receipt/${id}`, '_blank');

  // This destination's price in this currency, when the manager has set one.
  const price = outgoing
    ? config.prices.find((row) => row.destination === destination && row.currency === currency)
    : undefined;

  const applySum = useCallback(
    (typed: string) => {
      setSum(typed);
      setDone(null);
      if (!price) return;
      const amount = scaleAmount(typed);
      if (amount <= 0n) {
        setGross('');
        setNet('');
        return;
      }
      const worked = priceRemittance(
        amount,
        {
          charge: { kind: price.chargeKind as FeeKind, value: BigInt(price.chargeValue) },
          cost: { kind: price.costKind as FeeKind, value: BigInt(price.costValue) },
        },
        decimals,
      );
      setGross(plainAmount(worked.collected));
      setNet(plainAmount(worked.cost));
    },
    [price, decimals],
  );

  // A different destination or currency prices the same sum again.
  const priceKey = price?.id ?? '';
  useEffect(() => {
    if (sum) applySum(sum);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceKey]);

  const canPrice = permissions.includes('exchange.rate.manage');

  const tabs = (
    <div dir="rtl" className="grid grid-cols-3 gap-2 rounded-2xl bg-surface-sunken p-1.5">
      {(['OUT', 'IN', 'QUICK'] as const).map((option) => {
        const chosen = option === 'QUICK' ? quick : !quick && direction === option;
        const Icon =
          option === 'OUT' ? ArrowUpRight : option === 'IN' ? ArrowDownLeft : ClipboardPen;
        return (
          <button
            key={option}
            type="button"
            onClick={() => {
              setQuick(option === 'QUICK');
              if (option !== 'QUICK') setDirection(option);
              setDone(null);
            }}
            aria-pressed={chosen}
            className={cn(
              'flex min-h-12 items-center justify-center gap-1.5 rounded-xl px-1 text-sm font-semibold transition-colors',
              chosen
                ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                : 'text-content-tertiary hover:text-content-secondary',
            )}
          >
            <Icon className="size-4 shrink-0" />
            {option === 'OUT'
              ? t('remittance.outgoing')
              : option === 'IN'
                ? t('remittance.incoming')
                : t('remittance.quick')}
          </button>
        );
      })}
    </div>
  );

  if (quick) {
    return (
      <div className="mx-auto w-full max-w-xl space-y-4">
        {tabs}
        <QuickRemittance currencies={config.currencies} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="mx-auto w-full max-w-xl space-y-4"
    >
      {tabs}

      {/* ============ Where, and in what ============ */}
      <div className="grid gap-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-content-tertiary">{t('remittance.destination')}</span>
          {config.destinations.length === 0 ? (
            <p className="mt-1 flex h-12 items-center rounded-xl bg-surface-sunken px-3 text-sm text-danger-text">
              {t('remittance.noDestinations')}
            </p>
          ) : (
            <select
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value);
                setDone(null);
              }}
              className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
            >
              {config.destinations.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="block">
          <span className="text-xs text-content-tertiary">{t('remittance.currency')}</span>
          <select
            value={currency}
            onChange={(event) => {
              setCurrency(event.target.value);
              setDone(null);
            }}
            className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
          >
            {config.currencies.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {entry.code} — {ln(entry as unknown as Record<string, unknown>, 'name')}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/*
        ============ The sum, on this destination's price ============
        Only with a price to work from. It fills the two figures below it.
      */}
      {price && (
        <AmountRow
          label={t('remittance.sum')}
          hint={t('remittance.sumHint')}
          code={currency}
          decimals={decimals}
          value={sum}
          onType={(raw) => applySum(sanitiseAmount(raw, decimals))}
        />
      )}

      {/* ============ The two figures ============ */}
      <section className="space-y-2 rounded-3xl bg-surface p-2 shadow-[var(--shadow-lg)] ring-1 ring-border-subtle">
        <AmountRow
          label={outgoing ? t('remittance.customerPays') : t('remittance.correspondentCredits')}
          hint={outgoing ? t('remittance.customerPaysHint') : t('remittance.correspondentCreditsHint')}
          code={currency}
          decimals={decimals}
          value={gross}
          onType={(raw) => {
            setDone(null);
            setGross(sanitiseAmount(raw, decimals));
          }}
          inputRef={grossRef}
          hero
        />

        <AmountRow
          label={outgoing ? t('remittance.correspondentCharges') : t('remittance.customerReceives')}
          hint={
            outgoing ? t('remittance.priceLaterHint') : t('remittance.customerReceivesHint')
          }
          code={currency}
          decimals={decimals}
          value={net}
          onType={(raw) => {
            setDone(null);
            setNet(sanitiseAmount(raw, decimals));
          }}
        />
      </section>

      {/* ============ What reaches them, in what it reaches them in ============ */}
      {outgoing && (
        <div className="rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
          <span className="text-xs font-medium text-content-secondary">
            {t('remittance.delivered')}
          </span>
          <p className="text-[0.6875rem] text-content-tertiary">{t('remittance.deliveredHint')}</p>
          <div className="mt-2 flex items-center gap-3">
            <input
              aria-label={t('remittance.deliveredUnit')}
              list="remittance-units"
              maxLength={20}
              autoComplete="off"
              value={deliveredUnit}
              onChange={(event) => setDeliveredUnit(event.target.value)}
              className="h-11 w-24 shrink-0 rounded-xl bg-surface-sunken px-3 text-center text-sm font-semibold text-content outline-none ring-1 ring-transparent focus:ring-primary"
            />
            <datalist id="remittance-units">
              {['جنيه', 'دولار', 'دينار', 'شيكل', 'ليرة', 'درهم', 'ريال'].map((unit) => (
                <option key={unit} value={unit} />
              ))}
            </datalist>
            <input
              type="text"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              data-zoom-safe=""
              aria-label={t('remittance.delivered')}
              value={delivered}
              placeholder="0"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setDone(null);
                setDelivered(sanitiseAmount(event.target.value, 2));
              }}
              className="min-w-0 flex-1 bg-transparent text-end text-2xl font-semibold tabular-nums tracking-tight text-content outline-none placeholder:text-content-tertiary sm:text-3xl"
            />
          </div>
        </div>
      )}

      {/* The earning, as a consequence of the two figures above it. */}
      {canSeeMargin && grossValue > 0n && netValue > 0n && (
        <p
          className={cn(
            'text-center text-sm',
            margin < 0n ? 'text-danger-text' : 'text-content-secondary',
          )}
        >
          {margin < 0n ? t('remittance.belowCost') : t('remittance.margin')}{' '}
          <span className="font-semibold tabular-nums text-content ltr-content">
            {formatScaled(margin.toString(), decimals)} {currency}
          </span>
        </p>
      )}

      {/* ============ How the customer pays ============ */}
      {outgoing && (
        <div className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-content-secondary">
              {t('machine.intakeTitle')}
            </span>
            <div dir="ltr" className="flex gap-1 rounded-full bg-surface-sunken p-1">
              {(['CASH', 'TRANSFER'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={paidVia === option}
                  disabled={option === 'TRANSFER' && config.transferChannels.length === 0}
                  onClick={() => {
                    setPaidVia(option);
                    setDone(null);
                  }}
                  className={cn(
                    'h-9 rounded-full px-4 text-sm font-medium transition-colors disabled:opacity-40',
                    paidVia === option
                      ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                      : 'text-content-tertiary hover:text-content-secondary',
                  )}
                >
                  {option === 'CASH' ? t('machine.intakeCash') : t('machine.intakeTransfer')}
                </button>
              ))}
            </div>
          </div>
          {byTransfer && (
            <label className="mt-3 block">
              <span className="text-xs text-content-tertiary">{t('machine.intakeInto')}</span>
              <select
                value={intakeChannel}
                onChange={(event) => setIntakeChannel(event.target.value)}
                className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
              >
                {config.transferChannels.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {/* ============ What goes with it: two photos, each optional ============ */}
      {outgoing && (
        <div className="grid gap-3 sm:grid-cols-2">
          <PhotoField
            label={t('remittance.proof')}
            attach={byTransfer ? t('remittance.proofAttachTransfer') : t('remittance.proofAttach')}
            value={proof}
            onChange={setProof}
          />
          <PhotoField
            label={t('remittance.beneficiaryDetails')}
            attach={t('remittance.beneficiaryAttach')}
            value={beneficiaryPhoto}
            onChange={setBeneficiaryPhoto}
          />
        </div>
      )}

      {done && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-success-subtle px-4 py-3 ring-1 ring-success-border">
          <span className="flex items-center gap-2 text-sm text-content">
            <span className="flex size-6 items-center justify-center rounded-full bg-success">
              <Check className="size-4 text-white" />
            </span>
            {t('remittance.recorded')}
            <span className="font-mono ltr-content">{done.reference}</span>
          </span>
          {permissions.includes('exchange.receipt.print') && (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="ghost" icon={<Printer />} onClick={() => print(done.id)}>
                {t('transactions.printReceipt')}
              </Button>
              <AutoPrintToggle />
              <ShareButton transactionId={done.id} />
            </span>
          )}
        </div>
      )}

      {/*
        Who it is for. Required rather than optional: a transfer without a name
        on it is one nobody can chase when the other end says it never arrived.
      */}
      <div className="rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
        <p className="mb-3 text-sm font-medium text-content">
          {outgoing ? t('remittance.beneficiary') : t('remittance.sender')}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('remittance.name')} required={nameRequired}>
            {(props) => (
              <Input
                {...props}
                value={counterpartyName}
                onChange={(event) => setCounterpartyName(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={outgoing ? t('remittance.beneficiaryNumber') : t('remittance.phone')}
            required={byTransfer}
          >
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                inputMode="tel"
                value={counterpartyPhone}
                onChange={(event) => setCounterpartyPhone(event.target.value)}
              />
            )}
          </Field>

          <Field label={t('common.notes')} className="sm:col-span-2">
            {(props) => (
              <Input
                {...props}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            )}
          </Field>
        </div>
      </div>

      <button
        type="submit"
        disabled={blocked || posting}
        className={cn(
          'flex h-14 w-full items-center justify-center gap-2 rounded-2xl',
          'bg-primary text-base font-semibold text-white',
          'shadow-[var(--shadow-md)] transition-all duration-150',
          'hover:bg-primary-hover active:scale-[0.98]',
          'disabled:opacity-40 disabled:shadow-none disabled:active:scale-100',
        )}
      >
        {posting ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
        {outgoing ? t('remittance.send') : t('remittance.receive')}
      </button>

      <button
        type="button"
        onClick={reset}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-full text-sm text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content-secondary"
      >
        <RotateCcw className="size-4" />
        {t('machine.clear')}
      </button>

      {recent.length > 0 && (
        <div className="rounded-2xl bg-surface ring-1 ring-border-subtle">
          <p className="px-4 pt-3 text-xs font-medium text-content-tertiary">
            {t('machine.recent')}
          </p>
          <ul className="divide-y divide-border-subtle">
            {recent.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="ltr-content text-sm tabular-nums text-content">
                  {formatScaled(row.fromAmount, decimals)} {row.fromCurrency}
                </span>
                <span className="flex items-center gap-2">
                  <span className="hidden font-mono text-xs text-content-tertiary ltr-content sm:inline">
                    {row.reference}
                  </span>
                  {permissions.includes('exchange.receipt.print') && (
                    <button
                      type="button"
                      onClick={() => print(row.id)}
                      title={t('transactions.printReceipt')}
                      aria-label={t('transactions.printReceipt')}
                      className="flex size-10 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content sm:size-8"
                    >
                      <Printer className="size-4" />
                    </button>
                  )}
                  {permissions.includes('exchange.receipt.print') && (
                    <ShareButton transactionId={row.id} compact />
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>

      {outgoing && <UnpricedRemittances refresh={done?.id ?? null} />}

      {/* The price list, under the form it feeds, for whoever manages prices. */}
      {canPrice && config.destinations.length > 0 && (
        <RemittancePrices
          prices={config.prices}
          destinations={config.destinations}
          currencies={config.currencies.map((entry) => entry.code)}
        />
      )}
    </div>
  );
}

/**
 * Only writing down what was taken for remittances: what was typed is what is
 * recorded, with no destination, no price list and no message to the group.
 */
function QuickRemittance({ currencies }: { currencies: Config['currencies'] }) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [currency, setCurrency] = useState(currencies[0]?.code ?? 'ILS');
  const [received, setReceived] = useState('');
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [posting, setPosting] = useState(false);
  const receivedRef = useRef<HTMLInputElement>(null);

  const decimals = currencies.find((entry) => entry.code === currency)?.decimals ?? 2;
  const receivedValue = scaleAmount(received);
  const costValue = scaleAmount(cost);
  const belowCost = costValue > receivedValue && receivedValue > 0n;

  const submit = async () => {
    if (receivedValue <= 0n || costValue <= 0n || belowCost) return;
    setPosting(true);
    try {
      const result = await api.post<{ reference: string }>('/api/exchange/remittance/quick', {
        currency,
        received: unscale(receivedValue),
        cost: unscale(costValue),
        notes: note.trim() || null,
      });
      toast.success(t('remittance.recorded'), result.reference);
      setReceived('');
      setCost('');
      setNote('');
      receivedRef.current?.focus();
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setPosting(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="space-y-4"
    >
      <label className="block rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
        <span className="text-xs text-content-tertiary">{t('remittance.currency')}</span>
        <select
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
          className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
        >
          {currencies.map((entry) => (
            <option key={entry.code} value={entry.code}>
              {entry.code} — {ln(entry as unknown as Record<string, unknown>, 'name')}
            </option>
          ))}
        </select>
      </label>

      <section className="space-y-2 rounded-3xl bg-surface p-2 shadow-[var(--shadow-lg)] ring-1 ring-border-subtle">
        <AmountRow
          label={t('remittance.quickReceived')}
          hint={t('remittance.quickReceivedHint')}
          code={currency}
          decimals={decimals}
          value={received}
          onType={(raw) => setReceived(sanitiseAmount(raw, decimals))}
          inputRef={receivedRef}
          hero
        />
        <AmountRow
          label={t('remittance.correspondentCharges')}
          hint={t('remittance.correspondentChargesHint')}
          code={currency}
          decimals={decimals}
          value={cost}
          onType={(raw) => setCost(sanitiseAmount(raw, decimals))}
        />
      </section>

      {belowCost && (
        <p role="alert" className="text-sm text-danger-text">
          {t('errors.remittanceBelowCost')}
        </p>
      )}

      <div className="rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
        <Field label={t('common.notes')}>
          {(props) => (
            <Input
              {...props}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>
      </div>

      <button
        type="submit"
        disabled={receivedValue <= 0n || costValue <= 0n || belowCost || posting}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-base font-semibold text-white shadow-[var(--shadow-md)] transition-all duration-150 hover:bg-primary-hover active:scale-[0.98] disabled:opacity-40 disabled:shadow-none disabled:active:scale-100"
      >
        {posting ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
        {t('remittance.quickRecord')}
      </button>
    </form>
  );
}

/**
 * One of the two figures.
 *
 * Same shape as the exchange card's rows on purpose — the same hands use both
 * screens — but with the currency as a fixed pill rather than a picker, because
 * a remittance has one currency and offering to change it on each line would
 * invite a mismatch the server would only refuse.
 */
function AmountRow({
  label,
  hint,
  code,
  decimals,
  value,
  onType,
  inputRef,
  hero,
}: {
  label: string;
  hint: string;
  code: string;
  decimals: number;
  value: string;
  onType: (raw: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  hero?: boolean;
}) {
  const zero = (0).toFixed(decimals);

  return (
    <div className={cn('rounded-[1.35rem] bg-surface-sunken px-5', hero ? 'py-5' : 'py-4')}>
      <span className="text-xs font-medium text-content-secondary">{label}</span>
      <p className="text-[0.6875rem] text-content-tertiary">{hint}</p>

      <div className="mt-2 flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface text-sm font-semibold text-content-secondary shadow-[var(--shadow-sm)] ring-1 ring-border-subtle">
          {code}
        </span>

        <input
          ref={inputRef}
          type="text"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          data-zoom-safe=""
          aria-label={label}
          value={value}
          placeholder={zero}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onType(event.target.value)}
          className={cn(
            'min-w-0 flex-1 bg-transparent text-end tabular-nums tracking-tight outline-none',
            'placeholder:text-content-tertiary',
            hero ? 'text-3xl font-bold text-content sm:text-4xl' : 'text-2xl font-semibold text-content sm:text-3xl',
          )}
        />
      </div>
    </div>
  );
}

/** Keeps only what an amount can be, at the currency's own precision. */
function sanitiseAmount(raw: string, limit: number): string {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫٬]/g, '.')
    .replace(/[^\d.]/g, '');

  const [whole = '', ...rest] = cleaned.split('.');
  const hasPoint = rest.length > 0 && limit > 0;
  const fraction = rest.join('').slice(0, limit);

  const next = hasPoint ? `${whole}.${fraction}` : whole;
  return next.replace(/^0+(?=\d)/, '');
}

/**
 * A typed decimal, as the scaled integer the rest of the system uses.
 *
 * Parsed digit by digit rather than through `Number`: a float cannot hold
 * 1234567.89 exactly, and the error lands in the fraction — which is the part
 * the margin is measured in.
 */
function scaleAmount(text: string): bigint {
  const [whole = '', fraction = ''] = text.trim().split('.');
  const digits =
    (whole.replace(/\D/g, '') || '0') + fraction.replace(/\D/g, '').padEnd(8, '0').slice(0, 8);
  try {
    return BigInt(digits);
  } catch {
    return 0n;
  }
}

/** The inverse, for putting an amount back on the wire. */

/** A scaled amount as plain digits for a field: 1020, or 1020.5. */
function plainAmount(value: bigint): string {
  const digits = value.toString().padStart(9, '0');
  const fraction = digits.slice(-8).replace(/0+$/, '');
  return `${digits.slice(0, -8)}${fraction ? `.${fraction}` : ''}`;
}

function unscale(value: bigint): string {
  const digits = value.toString().padStart(9, '0');
  return `${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

/** Renders a 1e8-scaled string at a currency's own precision. */
function formatScaled(scaled: string, decimals: number): string {
  const value = BigInt(scaled || '0');
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(9, '0');

  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, decimals);

  const grouped = Number(whole).toLocaleString('en-US');
  const text = decimals > 0 ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${text}` : text;
}
