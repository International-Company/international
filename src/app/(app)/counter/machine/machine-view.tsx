'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeftRight,
  Check,
  Delete,
  Loader2,
  Printer,
  RotateCcw,
  TriangleAlert,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Button } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Field, Input } from '@/ui/form';
import { Money } from '@/ui/display';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';
import { cn } from '@/ui/utils';

/**
 * The counter keypad.
 *
 * Designed around one posture and one glance. An operator stands at a window
 * with a customer opposite, works on a tablet with one hand, and needs a single
 * number: what to hand over. So that number is the largest thing on the screen
 * and everything else arranges itself around it.
 *
 * Both amounts are live. Typing in either prices the other, because customers
 * arrive with both questions — "what do I get for this" and "I need exactly
 * this much" — and a counter that only answers the first makes the operator do
 * arithmetic in front of them.
 *
 * The three things that can stop a trade — no rate, an empty drawer, a limit —
 * are stated in the same place, before the figure is read out rather than after
 * it has been promised.
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
  requiresCustomer: boolean;
  overLimit: boolean;
}

interface RecentRow {
  id: string;
  reference: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  createdAt: string;
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
  const { t, ln } = useLocale();
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
  const [recent, setRecent] = useState<RecentRow[]>([]);

  const [from, to] = pair;
  const byCode = useMemo(
    () => new Map(config.currencies.map((currency) => [currency.code, currency])),
    [config.currencies],
  );
  const fromCurrency = byCode.get(from);
  const toCurrency = byCode.get(to);
  const canSeeSpread = permissions.includes('exchange.margin.view');

  const decimals = (side === 'pay' ? fromCurrency : toCurrency)?.decimals ?? 2;

  // --- The teller's own recent work, for a reprint ---------------------------
  //
  // Inside the tool rather than on a screen of its own: a lost receipt is asked
  // for at the counter, while the next customer waits.
  const loadRecent = useCallback(async () => {
    try {
      setRecent(
        await api.get<RecentRow[]>(
          `/api/manage/transactions${queryString({ recent: true, type: 'EXCHANGE', pageSize: 5 })}`,
        ),
      );
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  // --- Pricing ---------------------------------------------------------------
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
        .get<QuoteResponse>(`/api/exchange/machine${queryString({ from, to, [side]: value })}`)
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
  }, [amount, from, to, side, t]);

  // --- Keypad ----------------------------------------------------------------
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
  // has already been told about in words.
  const blocked =
    !quote || !quote.available || quote.overLimit || (quote.requiresCustomer && !customer);

  const submit = async () => {
    if (!quote || blocked) return;
    setPosting(true);
    try {
      const result = await api.post<{ id: string; reference: string }>('/api/exchange/machine', {
        from,
        to,
        [side]: amount.trim(),
        customerId: customer?.id ?? null,
        counterpartyName: counterpartyName.trim() || null,
      });

      toast.success(t('machine.recorded'), result.reference);
      setDone(result);
      setAmount('');
      setQuote(null);
      setCounterpartyName('');
      setCustomer(null);
      void loadRecent();
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

  const payAmount = side === 'pay' ? amount : quote ? quote.fromAmount : '';
  const receiveAmount = side === 'receive' ? amount : quote ? quote.toAmount : '';

  // The board figure for this pair, so the quote can be checked against what is
  // posted on the wall.
  const boardRate = board.find(
    (rate) =>
      (rate.baseCode === from && rate.quoteCode === to) ||
      (rate.baseCode === to && rate.quoteCode === from),
  );

  const print = (id: string) => window.open(`/print/receipt/${id}`, '_blank');

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      {/* ================= The trade ================= */}
      <div className="space-y-4">
        {/* --- Pair ---------------------------------------------------- */}
        <div className="rounded-[var(--radius-card)] border border-border-base bg-surface p-3">
          {/*
            Three across on a phone so six pairs make two even rows; on a wider
            screen they share one row. Wrapping left a single pair stranded on a
            full-width row of its own, which read as a different kind of button.
          */}
          <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
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
                    'min-h-11 rounded-[var(--radius-control)] border px-3 text-sm font-semibold sm:flex-1',
                    'ltr-content transition-colors duration-100',
                    active
                      ? 'border-primary bg-primary text-white shadow-sm'
                      : 'border-border-base bg-surface text-content-secondary hover:border-primary hover:text-content',
                  )}
                >
                  {a} → {b}
                </button>
              );
            })}
          </div>

          {/* The rate, in words rather than as a column heading. */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-base pt-3">
            <p className="text-sm text-content-secondary">
              {quote ? (
                <span className="ltr-content font-mono text-content">
                  1 {from} = {formatScaled(quote.rate, 4)} {to}
                </span>
              ) : boardRate ? (
                <span className="ltr-content font-mono text-content-tertiary">
                  {boardRate.baseCode}/{boardRate.quoteCode} {formatScaled(boardRate.buyRate, 4)} /{' '}
                  {formatScaled(boardRate.sellRate, 4)}
                </span>
              ) : (
                <span className="text-danger-text">{t('rates.noRateForPair')}</span>
              )}
            </p>

            {canSeeSpread && quote?.profit && (
              <p className="text-xs text-content-tertiary">
                {t('transactions.profit')}{' '}
                <Money value={quote.profit} currency={to} className="text-content-secondary" />
              </p>
            )}
          </div>
        </div>

        {/* --- The two amounts ----------------------------------------- */}
        <div className="relative rounded-[var(--radius-card)] border border-border-base bg-surface p-4">
          <AmountPanel
            label={t('machine.customerPays')}
            currency={fromCurrency}
            value={payAmount}
            active={side === 'pay'}
            onSelect={() => {
              if (side !== 'pay') {
                setSide('pay');
                setAmount(quote ? formatPlain(quote.fromAmount, fromCurrency?.decimals ?? 2) : '');
              }
            }}
            ln={ln}
          />

          {/* Swap sits on the seam between the two panels. */}
          <div className="relative my-2 flex items-center">
            <div className="h-px flex-1 bg-border-base" />
            <button
              type="button"
              onClick={swap}
              aria-label={t('machine.swap')}
              className="mx-3 flex size-10 items-center justify-center rounded-full border border-border-base bg-surface text-content-secondary transition-colors hover:border-primary hover:text-primary-text"
            >
              <ArrowLeftRight className="size-4" />
            </button>
            <div className="h-px flex-1 bg-border-base" />
          </div>

          <AmountPanel
            label={t('machine.customerReceives')}
            currency={toCurrency}
            value={receiveAmount}
            active={side === 'receive'}
            onSelect={() => {
              if (side !== 'receive') {
                setSide('receive');
                setAmount(quote ? formatPlain(quote.toAmount, toCurrency?.decimals ?? 2) : '');
              }
            }}
            ln={ln}
            hero
            busy={quoting}
          />
        </div>

        {/* --- Anything standing in the way ----------------------------- */}
        <div className="space-y-2">
          {error && <Blocker tone="danger">{error}</Blocker>}

          {quote && !quote.available && (
            <Blocker tone="danger" title={t('machine.cannotPayTitle')}>
              {t('machine.cannotPayBody', {
                account: `${t('drawers.title')} ${to}`,
                available: `${formatScaled(quote.availableAmount, toCurrency?.decimals ?? 2)} ${to}`,
              })}
            </Blocker>
          )}

          {quote?.overLimit && (
            <Blocker tone="warning" title={t('machine.overLimitTitle')}>
              {t('machine.overLimitBody', {
                maximum: `${formatScaled(config.maxAmount, fromCurrency?.decimals ?? 2)} ${from}`,
              })}
            </Blocker>
          )}

          {quote?.requiresCustomer && !customer && (
            <Blocker tone="warning" title={t('machine.customerRequiredTitle')}>
              {t('machine.customerRequiredBody')}
            </Blocker>
          )}

          {done && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-control)] border border-success bg-success-subtle p-3">
              <span className="flex items-center gap-2 text-sm text-content">
                <Check className="size-4 text-success-text" />
                {t('machine.recorded')}
                <span className="font-mono ltr-content">{done.reference}</span>
              </span>
              {permissions.includes('exchange.receipt.print') && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Printer />}
                  onClick={() => print(done.id)}
                >
                  {t('transactions.printReceipt')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/*
        The last few, for a reprint.

        A grid child rather than part of the trade column, so that on a phone —
        where the grid collapses to one column — it can fall below the keypad.
        A teller reaching for a digit should not have to scroll past yesterday.
        On a wide screen `order` puts it back under the trade column.
      */}
      {recent.length > 0 && (
        <div className="order-last rounded-[var(--radius-card)] border border-border-base bg-surface">
          <p className="border-b border-border-base px-4 py-2 text-xs font-medium uppercase tracking-wide text-content-secondary">
            {t('machine.recent')}
          </p>
          <ul className="divide-y divide-border-base">
            {recent.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-content-tertiary ltr-content">
                  {row.reference}
                </span>
                <span className="font-mono text-xs text-content ltr-content">
                  {formatScaled(row.fromAmount, byCode.get(row.fromCurrency)?.decimals ?? 2)}{' '}
                  {row.fromCurrency} →{' '}
                  {formatScaled(row.toAmount, byCode.get(row.toCurrency)?.decimals ?? 2)}{' '}
                  {row.toCurrency}
                </span>
                {permissions.includes('exchange.receipt.print') && (
                  <Button
                    variant="ghost"
                    size="icon"
                    title={t('transactions.printReceipt')}
                    onClick={() => print(row.id)}
                  >
                    <Printer className="size-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ================= Keypad and customer ================= */}
      <div className="space-y-4">
        <div className="rounded-[var(--radius-card)] border border-border-base bg-surface p-3">
          {/*
            The keypad and the quick amounts stay left-to-right in every
            language. A numeric keypad is muscle memory — 7 is at the top left
            of every calculator, cash register and phone, including Arabic ones
            — and letting the RTL layout mirror it would slow down the one
            operator who uses this hundreds of times a day.
          */}
          {config.quickAmounts.length > 0 && (
            <div dir="ltr" className="mb-3 grid grid-cols-3 gap-2">
              {config.quickAmounts.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setDone(null);
                    setAmount(String(value));
                  }}
                  className="min-h-10 rounded-[var(--radius-control)] border border-border-base bg-surface-sunken text-sm font-medium text-content-secondary transition-colors hover:border-primary hover:text-content"
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
              <Delete className="size-5" />
            </Key>
          </div>

          <div className="mt-3 grid grid-cols-[auto_1fr] gap-2">
            <Button variant="ghost" icon={<RotateCcw />} onClick={reset}>
              {t('machine.clear')}
            </Button>
            <Button
              variant="primary"
              size="lg"
              icon={<Check />}
              loading={posting}
              disabled={!quote || blocked || quoting}
              onClick={() => void submit()}
            >
              {t('machine.record')}
            </Button>
          </div>
        </div>

        <div className="rounded-[var(--radius-card)] border border-border-base bg-surface p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-content-secondary">
            {quote?.requiresCustomer
              ? t('machine.customerRequiredTitle')
              : t('machine.customerOptional')}
          </p>
          <div className="space-y-3">
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
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One side of the trade.
 *
 * The receiving side is the hero: it is the figure the operator reads out and
 * the customer checks, so it is twice the size of everything else on the screen
 * and the only thing carrying colour.
 */
function AmountPanel({
  label,
  currency,
  value,
  active,
  onSelect,
  hero,
  busy,
  ln,
}: {
  label: string;
  currency: Currency | undefined;
  value: string;
  active: boolean;
  onSelect: () => void;
  hero?: boolean;
  busy?: boolean;
  ln: (record: object, baseKey: string) => string;
}) {
  const decimals = currency?.decimals ?? 2;

  // While typing, show exactly what was typed — reformatting mid-entry moves
  // the digits under the operator's fingers.
  const display =
    value === '' ? (0).toFixed(decimals) : active ? value : formatScaled(value, decimals);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active}
      className={cn(
        'w-full rounded-[var(--radius-control)] border-2 px-4 text-start transition-colors',
        hero ? 'py-5' : 'py-4',
        active
          ? 'border-primary bg-primary-subtle'
          : 'border-transparent bg-surface-sunken hover:border-border-base',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-content-secondary">
          {label}
        </span>
        <span className="flex items-center gap-2 text-xs text-content-tertiary">
          {busy && <Loader2 className="size-3 animate-spin" />}
          {currency ? ln(currency as unknown as Record<string, unknown>, 'name') : ''}
        </span>
      </span>

      <span className="mt-1 flex items-baseline justify-between gap-3 ltr-content">
        <span
          className={cn(
            'font-mono tabular-nums tracking-tight',
            hero ? 'text-5xl font-bold text-primary-text' : 'text-3xl font-semibold text-content',
          )}
        >
          {display}
        </span>
        <span
          className={cn('font-semibold text-content-secondary', hero ? 'text-xl' : 'text-base')}
        >
          {currency?.code}
        </span>
      </span>
    </button>
  );
}

/** A reason the trade cannot go through, said plainly and in one place. */
function Blocker({
  tone,
  title,
  children,
}: {
  tone: 'danger' | 'warning';
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex gap-3 rounded-[var(--radius-control)] border p-3',
        tone === 'danger' ? 'border-danger bg-danger-subtle' : 'border-warning bg-warning-subtle',
      )}
    >
      <TriangleAlert
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'danger' ? 'text-danger-text' : 'text-warning-text',
        )}
      />
      <div className="min-w-0 text-sm">
        {title && <p className="font-medium text-content">{title}</p>}
        <p className="text-content-secondary">{children}</p>
      </div>
    </div>
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
        'flex h-16 items-center justify-center rounded-[var(--radius-control)] border border-border-base',
        'bg-surface text-2xl font-medium text-content tabular-nums',
        'transition-colors duration-75 hover:border-primary active:bg-surface-sunken',
        'disabled:opacity-40 disabled:hover:border-border-base',
      )}
      {...props}
    >
      {children}
    </button>
  );
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

/** Renders a 1e8-scaled string without grouping, for an editable field. */
function formatPlain(scaled: string, decimals: number): string {
  const value = BigInt(scaled || '0');
  const digits = value.toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, decimals);
  return decimals > 0 ? `${whole}.${fraction}` : whole;
}
