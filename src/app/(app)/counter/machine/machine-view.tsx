'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, Check, Delete, Printer, RotateCcw } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Money, Rate } from '@/ui/display';
import { Field, Input } from '@/ui/form';
import { cn } from '@/ui/utils';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';

/**
 * The counter keypad.
 *
 * Built for one posture: an operator standing at a window with a customer in
 * front of them, working on a tablet with one hand. So the targets are large,
 * the whole flow is four presses, and the two things that stop a trade — no
 * published rate, and an empty drawer — are stated before the teller reads a
 * figure out loud rather than after they have promised it.
 *
 * Both amount fields are live. Typing in either one prices the other, because
 * customers arrive with both questions: "what do I get for this" and "I need
 * exactly this much".
 */

interface Currency {
  code: string;
  nameEn: string;
  nameAr: string;
  symbol: string;
  decimals: number;
}

interface MachineConfig {
  enabled: boolean;
  pairs: string[];
  currencies: Currency[];
  quickAmounts: number[];
  maxAmount: string;
  requireCustomerAbove: string;
}

interface BoardRate {
  baseCode: string;
  quoteCode: string;
  buyRate: string;
  sellRate: string;
}

interface QuoteResponse {
  fromCurrency: string;
  toCurrency: string;
  fromAmount: string;
  toAmount: string;
  rate: string;
  side: 'BUY' | 'SELL';
  profit: string | null;
  available: boolean;
  availableAmount: string;
  payFromAccount: { id: string; code: string; nameEn: string; nameAr: string } | null;
  requiresCustomer: boolean;
  overLimit: boolean;
}

/** Which field the operator is typing into; the other one is derived. */
type Side = 'pay' | 'receive';

export function MachineView({
  config,
  board,
  permissions,
}: {
  config: MachineConfig;
  board: BoardRate[];
  permissions: string[];
}) {
  const { t, ln, locale } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const pairs = useMemo(
    () => config.pairs.map((pair) => pair.split('/') as [string, string]),
    [config.pairs],
  );

  const [pair, setPair] = useState<[string, string]>(pairs[0] ?? ['USD', 'ILS']);
  const [side, setSide] = useState<Side>('pay');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<QuoteResponse | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [done, setDone] = useState<{ id: string; reference: string } | null>(null);
  const [counterpartyName, setCounterpartyName] = useState('');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);

  const [from, to] = pair;
  const byCode = useMemo(
    () => new Map(config.currencies.map((currency) => [currency.code, currency])),
    [config.currencies],
  );
  const fromCurrency = byCode.get(from);
  const toCurrency = byCode.get(to);
  const canSeeSpread = permissions.includes('exchange.margin.view');

  const decimals = (side === 'pay' ? fromCurrency : toCurrency)?.decimals ?? 2;

  // --- Pricing -------------------------------------------------------------
  //
  // Debounced, and every response is checked against the request that is
  // current when it lands. Without that a slow reply for "50" can overwrite the
  // reply for "500" and the customer is quoted the wrong figure.
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
        .get<QuoteResponse>(
          `/api/exchange/machine${queryString({
            from,
            to,
            [side]: value,
          })}`,
        )
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
              ? t(cause.messageKey as never, cause.params) || cause.message
              : t('errors.generic'),
          );
        })
        .finally(() => {
          if (id === requestId.current) setQuoting(false);
        });
    }, 220);

    return () => clearTimeout(timer);
  }, [amount, from, to, side, t]);

  // --- Keypad --------------------------------------------------------------
  const press = useCallback(
    (key: string) => {
      setDone(null);
      setAmount((current) => {
        if (key === 'clear') return '';
        if (key === 'back') return current.slice(0, -1);
        if (key === '.') {
          if (decimals === 0 || current.includes('.')) return current;
          return current === '' ? '0.' : `${current}.`;
        }

        const [, fraction] = current.split('.');
        if (fraction !== undefined && fraction.length >= decimals) return current;
        if (current === '0') return key;
        return current + key;
      });
    },
    [decimals],
  );

  // A physical keyboard is faster than the on-screen pad for anyone who touch
  // types, and many counters have one. Both drive the same state.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (/^[0-9]$/.test(event.key)) press(event.key);
      else if (event.key === '.' || event.key === ',' || event.key === '٫') press('.');
      else if (event.key === 'Backspace') press('back');
      else if (event.key === 'Escape') press('clear');
      else return;

      event.preventDefault();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press]);

  const swap = () => {
    setPair(([a, b]) => {
      const reversed = `${b}/${a}`;
      return config.pairs.includes(reversed) ? [b, a] : [a, b];
    });
    setAmount('');
    setQuote(null);
    setDone(null);
  };

  const reset = () => {
    setAmount('');
    setQuote(null);
    setError(null);
    setDone(null);
    setCounterpartyName('');
    setCustomer(null);
  };

  // Every reason the record button is unavailable, each of which the operator
  // has already been told about in words above.
  const blocked =
    !quote || !quote.available || quote.overLimit || (quote.requiresCustomer && !customer);

  const submit = async () => {
    if (!quote || blocked) return;
    setPosting(true);
    try {
      const result = await api.post<{ id: string; reference: string }>(
        '/api/exchange/machine',
        {
          from,
          to,
          [side]: amount.trim(),
          customerId: customer?.id ?? null,
          counterpartyName: counterpartyName.trim() || null,
        },
      );

      toast.success(t('machine.recorded'), result.reference);
      setDone(result);
      setAmount('');
      setQuote(null);
      setCounterpartyName('');
      setCustomer(null);
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? t(cause.messageKey as never, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setPosting(false);
    }
  };

  // The board figure for this pair, shown so the teller can sanity-check the
  // quote against what is posted on the wall.
  const boardRate = board.find(
    (rate) =>
      (rate.baseCode === from && rate.quoteCode === to) ||
      (rate.baseCode === to && rate.quoteCode === from),
  );

  const payAmount = side === 'pay' ? amount : quote ? quote.fromAmount : '';
  const receiveAmount = side === 'receive' ? amount : quote ? quote.toAmount : '';

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
      {/* --- Pair, amounts and result ------------------------------------ */}
      <div className="space-y-4 lg:col-span-3">
        <Card>
          <CardHeader title={t('machine.pair')} />
          <CardBody className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {pairs.map(([a, b]) => {
                const active = a === from && b === to;
                return (
                  <button
                    key={`${a}/${b}`}
                    type="button"
                    onClick={() => {
                      setPair([a, b]);
                      setAmount('');
                      setQuote(null);
                      setDone(null);
                    }}
                    className={cn(
                      'min-h-11 rounded-[var(--radius-control)] border px-3 text-sm font-medium ltr-content',
                      'transition-colors duration-100',
                      active
                        ? 'border-primary bg-primary text-white'
                        : 'border-border-base bg-surface text-content hover:border-primary',
                    )}
                  >
                    {a} → {b}
                  </button>
                );
              })}
            </div>

            {boardRate && (
              <p className="text-xs text-content-secondary">
                {t('machine.boardRate')}{' '}
                <span className="ltr-content font-mono">
                  {boardRate.baseCode}/{boardRate.quoteCode}
                </span>{' '}
                <Rate value={boardRate.buyRate} /> / <Rate value={boardRate.sellRate} />
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-3">
            <AmountRow
              label={t('machine.customerPays')}
              currency={fromCurrency}
              value={payAmount}
              active={side === 'pay'}
              onFocus={() => {
                if (side !== 'pay') {
                  setSide('pay');
                  setAmount(quote?.fromAmount ? formatForEntry(quote.fromAmount, fromCurrency) : '');
                }
              }}
              locale={locale}
              ln={ln}
            />

            <div className="flex justify-center">
              <button
                type="button"
                onClick={swap}
                aria-label={t('machine.swap')}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-border-base bg-surface-sunken text-content-secondary transition-colors hover:border-primary hover:text-primary-text"
              >
                <ArrowLeftRight className="h-4 w-4" />
              </button>
            </div>

            <AmountRow
              label={t('machine.customerReceives')}
              currency={toCurrency}
              value={receiveAmount}
              active={side === 'receive'}
              onFocus={() => {
                if (side !== 'receive') {
                  setSide('receive');
                  setAmount(quote?.toAmount ? formatForEntry(quote.toAmount, toCurrency) : '');
                }
              }}
              locale={locale}
              ln={ln}
              emphasis
            />

            <div className="flex min-h-6 items-center gap-2 text-xs text-content-secondary">
              {quoting && <Spinner className="h-3 w-3" />}
              {quote && !quoting && (
                <>
                  <span>
                    {t('machine.rateApplied')} <Rate value={quote.rate} />
                  </span>
                  <Badge tone="neutral">
                    {quote.side === 'BUY' ? t('rates.buyRate') : t('rates.sellRate')}
                  </Badge>
                  {canSeeSpread && quote.profit && (
                    <span>
                      {t('transactions.profit')} <Money value={quote.profit} currency={to} />
                    </span>
                  )}
                </>
              )}
            </div>
          </CardBody>
        </Card>

        {error && <Alert tone="danger">{error}</Alert>}

        {quote && !quote.available && (
          <Alert tone="danger" title={t('machine.cannotPayTitle')}>
            {t('machine.cannotPayBody', {
              account: quote.payFromAccount ? ln(quote.payFromAccount, 'name') : to,
              available: `${formatForEntry(quote.availableAmount, toCurrency)} ${to}`,
            })}
          </Alert>
        )}

        {quote?.overLimit && (
          <Alert tone="warning" title={t('machine.overLimitTitle')}>
            {t('machine.overLimitBody', {
              maximum: `${formatForEntry(config.maxAmount, fromCurrency)} ${from}`,
            })}
          </Alert>
        )}

        {quote?.requiresCustomer && (
          <Alert tone="warning" title={t('machine.customerRequiredTitle')}>
            {t('machine.customerRequiredBody')}
          </Alert>
        )}

        {done && (
          <Alert tone="success" title={t('machine.recorded')}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono ltr-content">{done.reference}</span>
              {permissions.includes('exchange.receipt.print') && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Printer />}
                  onClick={() => window.open(`/print/receipt/${done.id}`, '_blank')}
                >
                  {t('transactions.printReceipt')}
                </Button>
              )}
            </div>
          </Alert>
        )}
      </div>

      {/* --- Keypad ------------------------------------------------------- */}
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardBody className="space-y-3">
            {/*
              Both grids stay left-to-right in every language.
              A numeric keypad is muscle memory — 7 is at the top left of every
              calculator, cash register and phone, including Arabic ones — and
              letting the RTL layout mirror it would slow down the one operator
              who uses this hundreds of times a day. Ascending quick amounts read
              the same way for the same reason.
            */}
            {config.quickAmounts.length > 0 && (
              <div dir="ltr" className="flex flex-wrap gap-2">
                {config.quickAmounts.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setDone(null);
                      setAmount(String(value));
                    }}
                    className="min-h-11 flex-1 rounded-[var(--radius-control)] border border-border-base bg-surface-sunken px-2 text-sm font-medium text-content ltr-content transition-colors hover:border-primary"
                  >
                    {value.toLocaleString('en-US')}
                  </button>
                ))}
              </div>
            )}

            <div dir="ltr" className="grid grid-cols-3 gap-2">
              {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((key) => (
                <Key key={key} onPress={() => press(key)}>
                  {key}
                </Key>
              ))}
              <Key onPress={() => press('.')} disabled={decimals === 0}>
                .
              </Key>
              <Key onPress={() => press('0')}>0</Key>
              <Key onPress={() => press('back')} aria-label={t('machine.backspace')}>
                <Delete className="h-5 w-5" />
              </Key>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button variant="ghost" icon={<RotateCcw />} onClick={reset}>
                {t('machine.clear')}
              </Button>
              <Button
                variant="primary"
                icon={<Check />}
                loading={posting}
                disabled={!quote || blocked || quoting}
                onClick={() => void submit()}
              >
                {t('machine.record')}
              </Button>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={quote?.requiresCustomer ? t('machine.customerRequiredTitle') : t('machine.customerOptional')}
          />
          <CardBody className="space-y-3">
            <CustomerPicker
              value={customer}
              onChange={setCustomer}
              permissions={permissions}
              required={quote?.requiresCustomer}
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
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

/** A large, non-editable amount display that behaves like a focusable field. */
function AmountRow({
  label,
  currency,
  value,
  active,
  onFocus,
  emphasis,
  locale,
  ln,
}: {
  label: string;
  currency: Currency | undefined;
  value: string;
  active: boolean;
  onFocus: () => void;
  emphasis?: boolean;
  locale: string;
  ln: (row: Record<string, unknown>, base: string) => string;
}) {
  const decimals = currency?.decimals ?? 2;
  const display =
    value === ''
      ? (0).toFixed(decimals)
      : // While typing, show exactly what was typed. Reformatting mid-entry
        // moves the caret under the operator's fingers.
        active
        ? value
        : formatForEntry(value, currency);

  return (
    <button
      type="button"
      onClick={onFocus}
      aria-current={active}
      className={cn(
        'w-full rounded-[var(--radius-control)] border px-4 py-3 text-start transition-colors',
        active ? 'border-primary bg-surface' : 'border-border-base bg-surface-sunken',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-content-secondary">{label}</span>
        <span className="text-xs text-content-tertiary">
          {currency ? ln(currency as unknown as Record<string, unknown>, 'name') : ''}
        </span>
      </span>
      <span className="mt-1 flex items-baseline gap-2 ltr-content">
        <span
          className={cn(
            'font-mono tabular-nums text-content',
            emphasis ? 'text-3xl font-semibold' : 'text-2xl',
          )}
        >
          {Number.isNaN(Number(display)) ? display : display}
        </span>
        <span className="text-sm text-content-secondary">{currency?.code}</span>
      </span>
    </button>
  );
}

function Key({
  children,
  onPress,
  disabled,
  ...props
}: {
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      className={cn(
        'flex h-14 items-center justify-center rounded-[var(--radius-control)] border border-border-base',
        'bg-surface text-xl font-medium text-content tabular-nums',
        'transition-colors duration-75 active:bg-surface-sunken hover:border-primary',
        'disabled:opacity-40 disabled:hover:border-border-base',
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** Renders a 1e8-scaled string at a currency's own precision. */
function formatForEntry(scaled: string, currency: Currency | undefined): string {
  const decimals = currency?.decimals ?? 2;
  const value = BigInt(scaled || '0');
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(9, '0');

  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, decimals);

  const text = decimals > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${text}` : text;
}
