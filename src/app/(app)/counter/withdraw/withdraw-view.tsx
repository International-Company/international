'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Printer, RotateCcw, TriangleAlert, Wallet } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { normalizeDigits } from '@/core/money/money';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Button } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Field, Input } from '@/ui/form';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';
import { cn } from '@/ui/utils';

/**
 * Selling USDT at the window.
 *
 * The receiving screen answers "someone is sending us coins"; this one answers
 * "someone wants coins and is paying for them". So it is shaped like the
 * exchange machine rather than like the receiving screen: an amount, a way of
 * paying, and the figure that follows from the two.
 *
 * The address is the one thing here that cannot be undone. It is therefore the
 * last field, checked against the network of the wallet it will be sent from
 * before anything is recorded, and shown back in full rather than truncated —
 * a shortened address is unverifiable, and verifying it is the entire point.
 */

interface Currency {
  code: string;
  nameEn: string;
  nameAr: string;
  symbol: string;
  decimals: number;
}

interface WalletOption {
  id: string;
  label: string;
  labelAr: string;
  network: string;
  address: string;
}

interface Config {
  enabled: boolean;
  wallets: WalletOption[];
  currencies: Currency[];
  transferChannels: string[];
  maxAmount: string;
}

interface ChannelPrice {
  fromAmount: string;
  toAmount: string;
  rate: string;
  profit: string | null;
}

interface QuoteResponse {
  payCurrency: string;
  cash: ChannelPrice | null;
  broker: ChannelPrice | null;
  availableUsdt: string;
}

type Mode = 'CASH' | 'BROKER' | 'SPLIT';

/** USDT is quoted to two places at the counter, like every other figure here. */
const USDT_DECIMALS = 2;

export function WithdrawView({
  config,
  permissions,
}: {
  config: Config;
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [currency, setCurrency] = useState(config.currencies[0]?.code ?? 'ILS');
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<Mode>('CASH');
  const [brokerShare, setBrokerShare] = useState('');
  const [account, setAccount] = useState(config.transferChannels[0] ?? '');
  const [walletId, setWalletId] = useState(config.wallets[0]?.id ?? '');
  const [address, setAddress] = useState('');

  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [counterpartyName, setCounterpartyName] = useState('');

  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [done, setDone] = useState<{ id: string; reference: string } | null>(null);

  const amountRef = useRef<HTMLInputElement>(null);

  const selected = config.currencies.find((entry) => entry.code === currency);
  const decimals = selected?.decimals ?? 2;
  const wallet = config.wallets.find((entry) => entry.id === walletId);
  const canSeeMargin = permissions.includes('exchange.margin.view');

  // --- Pricing ---------------------------------------------------------------
  //
  // Debounced, and every response is checked against the request current when it
  // lands: without that a slow reply for "50" can overwrite the reply for "500"
  // and the customer is told the wrong figure.
  const requestId = useRef(0);

  useEffect(() => {
    const value = amount.trim();
    if (!value || Number(value) <= 0) {
      setQuote(null);
      setError(null);
      setQuoting(false);
      return;
    }

    const id = ++requestId.current;
    setQuoting(true);

    const timer = setTimeout(() => {
      void api
        .get<QuoteResponse>(`/api/usdt/withdrawal${queryString({ currency, pay: value })}`)
        .then((result) => {
          if (id !== requestId.current) return;
          setQuote(result);
          setError(null);
        })
        .catch((cause) => {
          if (id !== requestId.current) return;
          setQuote(null);
          setError(
            cause instanceof ApiError
              ? t(cause.messageKey as never, cause.params as Record<string, string>) ||
                  cause.message
              : t('errors.generic'),
          );
        })
        .finally(() => {
          if (id === requestId.current) setQuoting(false);
        });
    }, 220);

    return () => clearTimeout(timer);
  }, [amount, currency, t]);

  /*
   * What each channel buys, priced at its own rate.
   *
   * The split is a share of what the customer pays, not of the coins they get —
   * the coins are not known until both parts have been priced, so they cannot be
   * the thing divided. Each part is converted at its channel's per-unit rate,
   * which is exactly what the server does again before it posts.
   */
  const legs = (() => {
    const none = { cash: 0n, broker: 0n, paid: 0n };
    if (!quote) return none;

    if (mode === 'CASH') {
      return quote.cash
        ? { cash: BigInt(quote.cash.toAmount), broker: 0n, paid: BigInt(quote.cash.fromAmount) }
        : none;
    }
    if (mode === 'BROKER') {
      return quote.broker
        ? { cash: 0n, broker: BigInt(quote.broker.toAmount), paid: BigInt(quote.broker.fromAmount) }
        : none;
    }

    if (!quote.cash || !quote.broker) return none;

    const paid = BigInt(quote.cash.fromAmount);
    const typed = scaleAmount(brokerShare);
    const viaBroker = typed > paid ? paid : typed;

    return {
      cash: applyRate(paid - viaBroker, quote.cash.rate, USDT_DECIMALS),
      broker: applyRate(viaBroker, quote.broker.rate, USDT_DECIMALS),
      paid,
    };
  })();

  /** What the customer walks away with, across both ways of paying. */
  const received = legs.cash + legs.broker;

  const margin = (() => {
    if (!canSeeMargin || !quote) return null;
    if (mode === 'CASH') return quote.cash ? BigInt(quote.cash.profit ?? '0') : null;
    if (mode === 'BROKER') return quote.broker ? BigInt(quote.broker.profit ?? '0') : null;

    if (!quote.cash?.profit || !quote.broker?.profit || legs.paid === 0n) return null;
    const typed = scaleAmount(brokerShare);
    const viaBroker = typed > legs.paid ? legs.paid : typed;
    return (
      (BigInt(quote.cash.profit) * (legs.paid - viaBroker)) / legs.paid +
      (BigInt(quote.broker.profit) * viaBroker) / legs.paid
    );
  })();

  /** No price published for the way the teller has chosen to take payment. */
  const noPrice =
    quote !== null &&
    ((mode === 'CASH' && !quote.cash) ||
      (mode === 'BROKER' && !quote.broker) ||
      (mode === 'SPLIT' && (!quote.cash || !quote.broker)));

  const short = quote !== null && received > BigInt(quote.availableUsdt);
  const overLimit = BigInt(config.maxAmount) > 0n && received > BigInt(config.maxAmount);

  const blocked =
    !quote ||
    noPrice ||
    received <= 0n ||
    short ||
    overLimit ||
    !walletId ||
    address.trim().length < 10 ||
    (mode !== 'CASH' && !account) ||
    (!customer && !counterpartyName.trim());

  const reset = useCallback(() => {
    setAmount('');
    setBrokerShare('');
    setMode('CASH');
    setAddress('');
    setCustomer(null);
    setCounterpartyName('');
    setQuote(null);
    setDone(null);
    amountRef.current?.focus();
  }, []);

  const submit = async () => {
    if (blocked) return;
    setPosting(true);
    try {
      const result = await api.post<{ id: string; reference: string }>('/api/usdt/withdrawal', {
        currency,
        pay: amount.trim(),
        mode,
        /*
         * Only the broker's share travels. The till takes the rest and the
         * server prices both legs from its own board — sending the totals would
         * let a screen holding a stale price post figures never quoted.
         */
        brokerShare: mode === 'SPLIT' ? unscale(scaleAmount(brokerShare)) : undefined,
        intakeChannel: mode === 'CASH' ? null : account,
        address: address.trim(),
        walletId,
        customerId: customer?.id ?? null,
        counterpartyName: counterpartyName.trim() || null,
      });

      toast.success(t('withdraw.recorded'), result.reference);
      setDone(result);
      setAmount('');
      setBrokerShare('');
      setAddress('');
      setQuote(null);
      setCustomer(null);
      setCounterpartyName('');
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? t(cause.messageKey as never, cause.params as Record<string, string>) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setPosting(false);
    }
  };

  const print = (id: string) => window.open(`/print/receipt/${id}`, '_blank');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="mx-auto w-full max-w-xl space-y-4"
    >
      {/* ============ What the customer pays ============ */}
      <section className="space-y-2 rounded-3xl bg-surface p-2 shadow-[var(--shadow-lg)] ring-1 ring-border-subtle">
        <div className="rounded-[1.35rem] bg-surface-sunken px-5 py-5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-content-secondary">
              {t('withdraw.customerPays')}
            </span>
            {quoting && <Loader2 className="size-3.5 animate-spin text-content-tertiary" />}
          </div>

          <div className="mt-3 flex items-center gap-3">
            <select
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
                setDone(null);
              }}
              aria-label={t('withdraw.currency')}
              className="h-10 shrink-0 rounded-full bg-surface px-3 text-sm font-semibold text-content shadow-[var(--shadow-sm)] ring-1 ring-border-subtle outline-none focus:ring-primary"
            >
              {config.currencies.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code}
                </option>
              ))}
            </select>

            <input
              ref={amountRef}
              type="text"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              data-zoom-safe=""
              aria-label={t('withdraw.customerPays')}
              value={amount}
              placeholder={(0).toFixed(decimals)}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setDone(null);
                setAmount(sanitiseAmount(event.target.value, decimals));
              }}
              className="min-w-0 flex-1 bg-transparent text-end text-3xl font-semibold tabular-nums tracking-tight text-content outline-none placeholder:text-content-tertiary sm:text-4xl"
            />
          </div>
        </div>

        {/* --- And what that buys ------------------------------------------ */}
        <div className="rounded-[1.35rem] bg-primary-subtle px-5 py-6">
          <span className="text-xs font-medium text-content-secondary">
            {t('withdraw.customerReceives')}
          </span>
          <div className="mt-3 flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
              ₮
            </span>
            <p className="min-w-0 flex-1 text-end text-4xl font-bold tabular-nums tracking-tight text-primary-text ltr-content sm:text-5xl">
              {formatScaled(received.toString(), USDT_DECIMALS)}
            </p>
          </div>
        </div>
      </section>

      {/* The rate, as one quiet line. */}
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm">
        {received > 0n && legs.paid > 0n && (
          <span className="ltr-content font-medium tabular-nums text-content">
            1 {currency} = {formatScaled(perUnit(legs.paid, received).toString(), 6)} USDT
          </span>
        )}
        {canSeeMargin && margin !== null && (
          <span className="text-content-tertiary">
            {t('transactions.profit')}{' '}
            <span className="tabular-nums text-content-secondary ltr-content">
              {formatScaled(margin.toString(), USDT_DECIMALS)} USDT
            </span>
          </span>
        )}
      </div>

      {/* ============ How they are paying ============ */}
      <div className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-content-secondary">
            {t('withdraw.paidBy')}
          </span>

          <div dir="ltr" className="flex gap-1 rounded-full bg-surface-sunken p-1">
            {(['CASH', 'BROKER', 'SPLIT'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setMode(option);
                  setDone(null);
                  if (option !== 'SPLIT') setBrokerShare('');
                }}
                aria-pressed={mode === option}
                className={cn(
                  'h-9 rounded-full px-4 text-sm font-medium transition-colors',
                  mode === option
                    ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                    : 'text-content-tertiary hover:text-content-secondary',
                )}
              >
                {option === 'CASH'
                  ? t('machine.payoutCash')
                  : option === 'BROKER'
                    ? t('machine.payoutBank')
                    : t('machine.payoutSplit')}
              </button>
            ))}
          </div>
        </div>

        {mode !== 'CASH' && config.transferChannels.length > 0 && (
          <label className="mt-3 block">
            <span className="text-xs text-content-tertiary">{t('withdraw.paidInto')}</span>
            <select
              value={account}
              onChange={(event) => {
                setDone(null);
                setAccount(event.target.value);
              }}
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

        {mode === 'SPLIT' && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-content-tertiary">{t('machine.payoutBankLeg')}</span>
              <input
                type="text"
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                data-zoom-safe=""
                value={brokerShare}
                placeholder={(0).toFixed(decimals)}
                onChange={(event) => {
                  setDone(null);
                  const typed = sanitiseAmount(event.target.value, decimals);
                  /*
                   * Held at the total. More than the payment cannot be
                   * transferred, and a field showing a figure larger than the
                   * one that will move is a display disagreeing with itself.
                   */
                  const paid = quote?.cash ? BigInt(quote.cash.fromAmount) : 0n;
                  setBrokerShare(
                    paid > 0n && scaleAmount(typed) > paid
                      ? formatPlain(paid.toString(), decimals)
                      : typed,
                  );
                }}
                className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-end text-xl font-semibold tabular-nums text-content outline-none ring-1 ring-transparent focus:ring-primary"
              />
            </label>

            <div className="block">
              <span className="text-xs text-content-tertiary">{t('machine.payoutCashLeg')}</span>
              <p className="mt-1 flex h-12 items-center justify-end rounded-xl bg-surface-sunken px-3 text-xl font-semibold tabular-nums text-content-secondary ltr-content">
                {formatScaled(
                  (
                    legs.paid -
                    (scaleAmount(brokerShare) > legs.paid ? legs.paid : scaleAmount(brokerShare))
                  ).toString(),
                  decimals,
                )}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ============ Where it is going ============ */}
      <div className="space-y-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
        <label className="block">
          <span className="text-xs text-content-tertiary">{t('withdraw.sendFrom')}</span>
          <select
            value={walletId}
            onChange={(event) => {
              setWalletId(event.target.value);
              setDone(null);
            }}
            className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
          >
            {config.wallets.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {ln(entry as unknown as Record<string, unknown>, 'label')} — {entry.network}
              </option>
            ))}
          </select>
        </label>

        <Field label={t('withdraw.address')} required hint={t('withdraw.addressHint')}>
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={address}
              onChange={(event) => {
                setDone(null);
                setAddress(event.target.value.trim());
              }}
              className="font-mono"
            />
          )}
        </Field>

        {/*
          Shown back in full, in the network's own name. A teller who pasted the
          wrong network's address has no other chance to notice: the chain will
          take it and nobody can bring it back.
        */}
        {address.length >= 10 && wallet && (
          <p className="rounded-xl bg-surface-sunken px-3 py-2 text-xs text-content-secondary">
            <span className="font-medium">{wallet.network}</span>
            <span className="mx-2">·</span>
            <span className="break-all font-mono ltr-content">{address}</span>
          </p>
        )}
      </div>

      {/* --- Anything standing in the way ---------------------------------- */}
      {error && <Blocker>{error}</Blocker>}

      {noPrice && <Blocker>{t('rates.noRateForPair')}</Blocker>}

      {short && quote && (
        <Blocker title={t('withdraw.cannotSendTitle')}>
          {t('withdraw.cannotSendBody', {
            available: `${formatScaled(quote.availableUsdt, USDT_DECIMALS)} USDT`,
          })}
        </Blocker>
      )}

      {overLimit && (
        <Blocker title={t('withdraw.overLimitTitle')}>
          {t('withdraw.overLimitBody', {
            maximum: `${formatScaled(config.maxAmount, USDT_DECIMALS)} USDT`,
          })}
        </Blocker>
      )}

      {done && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-success-subtle px-4 py-3 ring-1 ring-success-border">
          <span className="flex items-center gap-2 text-sm text-content">
            <span className="flex size-6 items-center justify-center rounded-full bg-success">
              <Check className="size-4 text-white" />
            </span>
            {t('withdraw.recorded')}
            <span className="font-mono ltr-content">{done.reference}</span>
          </span>
          {permissions.includes('exchange.receipt.print') && (
            <Button size="sm" variant="ghost" icon={<Printer />} onClick={() => print(done.id)}>
              {t('transactions.printReceipt')}
            </Button>
          )}
        </div>
      )}

      {/* The coins are promised, not yet sent. Said before recording, not after. */}
      <p className="flex items-start gap-2 px-1 text-xs text-content-tertiary">
        <Wallet className="mt-0.5 size-3.5 shrink-0" />
        {t('withdraw.thenSend')}
      </p>

      {/* ============ Who is at the window ============ */}
      <div className="grid gap-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle sm:grid-cols-2">
        <CustomerPicker value={customer} onChange={setCustomer} permissions={permissions} />
        {!customer && (
          <Field label={t('transactions.counterpartyName')} required>
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

      <button
        type="submit"
        disabled={blocked || quoting || posting}
        className={cn(
          'flex h-14 w-full items-center justify-center gap-2 rounded-2xl',
          'bg-primary text-base font-semibold text-white',
          'shadow-[var(--shadow-md)] transition-all duration-150',
          'hover:bg-primary-hover active:scale-[0.98]',
          'disabled:opacity-40 disabled:shadow-none disabled:active:scale-100',
        )}
      >
        {posting ? <Loader2 className="size-5 animate-spin" /> : <Check className="size-5" />}
        {t('withdraw.record')}
      </button>

      <button
        type="button"
        onClick={reset}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-full text-sm text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content-secondary"
      >
        <RotateCcw className="size-4" />
        {t('machine.clear')}
      </button>
    </form>
  );
}

/** A reason the trade cannot go through, said plainly and in one place. */
function Blocker({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 rounded-2xl bg-danger-subtle px-4 py-3 ring-1 ring-danger-border">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" />
      <div className="min-w-0 text-sm">
        {title && <p className="font-medium text-content">{title}</p>}
        <p className="text-content-secondary">{children}</p>
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
 * Converts an amount at a per-unit rate, both scaled 1e8, rounding half-up to
 * the target's precision — the same arithmetic the server performs, so the
 * figure read out is the figure that gets posted.
 */
function applyRate(amount: bigint, rate: string, decimals: number): bigint {
  const product = amount * BigInt(rate);
  const step = 10n ** BigInt(16 - decimals);
  const rounded = (product + step / 2n) / step;
  return (rounded * step) / 100000000n;
}

/** What the customer got per unit, across both legs. */
function perUnit(paid: bigint, received: bigint): bigint {
  if (paid === 0n) return 0n;
  return (received * 100000000n) / paid;
}

/**
 * A typed decimal, as the scaled integer the rest of the system uses. Parsed
 * digit by digit rather than through `Number`: a float cannot hold 1234567.89
 * exactly, and the error lands in the fraction.
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
function unscale(value: bigint): string {
  const digits = value.toString().padStart(9, '0');
  return `${digits.slice(0, -8)}.${digits.slice(-8)}`;
}

/** Renders a 1e8-scaled string at a given precision. */
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

/** The same, without grouping, for an editable field. */
function formatPlain(scaled: string, decimals: number): string {
  const digits = BigInt(scaled || '0').toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, decimals);
  return decimals > 0 ? `${whole}.${fraction}` : whole;
}
