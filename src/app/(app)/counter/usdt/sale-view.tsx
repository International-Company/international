'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, History, Loader2, NotebookPen, Printer, RotateCcw } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { normalizeDigits } from '@/core/money/money';
import { api, ApiError, queryString } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button } from '@/ui/primitives';
import { ShareButton } from '@/ui/share';
import { useToast } from '@/ui/overlay';
import { Field, Input } from '@/ui/form';
import { CustomerPicker, type CustomerHit } from '@/ui/customer-picker';
import { cn } from '@/ui/utils';

/**
 * بيع USDT — تسجيل فقط.
 *
 * The teller has sold coins and sent them himself; this puts the sale on the
 * record. How many coins, at what price, paid how, and to whom — the total
 * follows from the first two, shown large, and the server works it out again
 * before anything is posted. No address, no wallet, no send.
 */

interface Currency {
  code: string;
  decimals: number;
}

type Mode = 'CASH' | 'BROKER';

interface RecentSale {
  id: string;
  reference: string;
  status: string;
  fromCurrency: string;
  fromAmount: string;
  toAmount: string;
  createdAt: string;
  counterpartyName: string | null;
}

const USDT_DECIMALS = 2;

export function SaleView({
  currencies,
  transferChannels,
  permissions,
}: {
  currencies: Currency[];
  transferChannels: string[];
  permissions: string[];
}) {
  const { t } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [usdt, setUsdt] = useState('');
  const [currency, setCurrency] = useState(currencies[0]?.code ?? 'ILS');
  const [price, setPrice] = useState('');
  const [mode, setMode] = useState<Mode>('CASH');
  const [account, setAccount] = useState(transferChannels[0] ?? '');
  const [customer, setCustomer] = useState<CustomerHit | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [posting, setPosting] = useState(false);
  const [done, setDone] = useState<{ id: string; reference: string } | null>(null);
  const [recent, setRecent] = useState<RecentSale[]>([]);
  const usdtRef = useRef<HTMLInputElement>(null);

  const loadRecent = useCallback(async () => {
    try {
      setRecent(
        await api.get<RecentSale[]>(
          `/api/manage/transactions${queryString({ recent: true, type: 'USDT_SALE', pageSize: 5 })}`,
        ),
      );
    } catch {
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const decimals = currencies.find((entry) => entry.code === currency)?.decimals ?? 2;

  // The total, by the same arithmetic the server uses.
  const coins = scaleAmount(usdt);
  const perCoin = scaleAmount(price);
  const total = totalOf(coins, perCoin, decimals);

  const blocked =
    coins <= 0n ||
    perCoin <= 0n ||
    total <= 0n ||
    (mode === 'BROKER' &&
      (!account ||
        (!customer && (!name.trim() || !phone.trim())) ||
        (customer && !customer.phone && !phone.trim())));

  const clear = () => {
    setUsdt('');
    setPrice('');
    setMode('CASH');
    setCustomer(null);
    setName('');
    setPhone('');
    setNotes('');
  };

  const reset = () => {
    clear();
    setDone(null);
    usdtRef.current?.focus();
  };

  const submit = async () => {
    if (blocked) return;
    setPosting(true);
    try {
      const result = await api.post<{ id: string; reference: string }>('/api/usdt/sales', {
        currency,
        usdt: usdt.trim(),
        price: price.trim(),
        mode,
        intakeChannel: mode === 'BROKER' ? account : null,
        customerId: customer?.id ?? null,
        counterpartyName: customer ? null : name.trim() || null,
        counterpartyPhone: phone.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success(t('usdtSale.recorded'), result.reference);
      setDone(result);
      clear();
      router.refresh();
      void loadRecent();
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
  const canPrint = permissions.includes('exchange.receipt.print');

  const bigInput =
    'min-w-0 flex-1 bg-transparent text-end text-3xl font-semibold tabular-nums tracking-tight text-content outline-none placeholder:text-content-tertiary sm:text-4xl';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="mx-auto w-full max-w-xl space-y-4"
    >
      <p className="flex items-start gap-2 rounded-2xl bg-warning-subtle px-4 py-3 text-sm text-content-secondary ring-1 ring-warning/30">
        <NotebookPen className="mt-0.5 size-4 shrink-0 text-warning-text" />
        {t('usdtSale.hint')}
      </p>

      {/* ============ The coins, the price, the total ============ */}
      <section className="space-y-2 rounded-3xl bg-surface p-2 shadow-[var(--shadow-lg)] ring-1 ring-border-subtle">
        <div className="rounded-[1.35rem] bg-surface-sunken px-5 py-5">
          <span className="text-xs font-medium text-content-secondary">{t('usdtSale.coins')}</span>
          <div className="mt-3 flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
              ₮
            </span>
            <input
              ref={usdtRef}
              type="text"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              data-zoom-safe=""
              aria-label={t('usdtSale.coins')}
              value={usdt}
              placeholder="0.00"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setDone(null);
                setUsdt(sanitiseAmount(event.target.value, USDT_DECIMALS));
              }}
              className={bigInput}
            />
          </div>
        </div>

        <div className="rounded-[1.35rem] bg-surface-sunken px-5 py-4">
          <span className="text-xs font-medium text-content-secondary">{t('usdtSale.price')}</span>
          <div className="mt-2 flex items-center gap-3">
            <select
              value={currency}
              onChange={(event) => {
                setCurrency(event.target.value);
                setDone(null);
              }}
              aria-label={t('withdraw.currency')}
              className="h-10 shrink-0 rounded-full bg-surface px-3 text-sm font-semibold text-content shadow-[var(--shadow-sm)] ring-1 ring-border-subtle outline-none focus:ring-primary"
            >
              {currencies.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code}
                </option>
              ))}
            </select>
            <input
              type="text"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              data-zoom-safe=""
              aria-label={t('usdtSale.price')}
              value={price}
              placeholder="0.0000"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setDone(null);
                setPrice(sanitiseAmount(event.target.value, 6));
              }}
              className="min-w-0 flex-1 bg-transparent text-end text-2xl font-semibold tabular-nums text-content outline-none placeholder:text-content-tertiary"
            />
          </div>
        </div>

        <div className="rounded-[1.35rem] bg-primary-subtle px-5 py-6">
          <span className="text-xs font-medium text-content-secondary">
            {t('usdtSale.customerPays')}
          </span>
          <p className="mt-3 text-end text-4xl font-bold tabular-nums tracking-tight text-primary-text ltr-content sm:text-5xl">
            {formatScaled(total.toString(), decimals)}{' '}
            <span className="text-lg font-semibold">{currency}</span>
          </p>
        </div>
      </section>

      {/* ============ How they paid ============ */}
      <div className="rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs font-medium text-content-secondary">{t('withdraw.paidBy')}</span>
          <div className="flex gap-1 rounded-full bg-surface-sunken p-1">
            {(['CASH', 'BROKER'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setMode(option);
                  setDone(null);
                }}
                aria-pressed={mode === option}
                className={cn(
                  'h-9 rounded-full px-4 text-sm font-medium transition-colors',
                  mode === option
                    ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                    : 'text-content-tertiary hover:text-content-secondary',
                )}
              >
                {option === 'CASH' ? t('machine.payoutCash') : t('machine.payoutBank')}
              </button>
            ))}
          </div>
        </div>

        {mode === 'BROKER' && (
          <label className="mt-3 block">
            <span className="text-xs text-content-tertiary">{t('withdraw.paidInto')}</span>
            <select
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              className="mt-1 h-12 w-full rounded-xl bg-surface-sunken px-3 text-base font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary"
            >
              {transferChannels.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* ============ Who bought ============ */}
      <div className="grid gap-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle sm:grid-cols-2">
        <CustomerPicker value={customer} onChange={setCustomer} permissions={permissions} />
        {!customer && (
          <Field label={t('transactions.counterpartyName')} required={mode === 'BROKER'}>
            {(props) => (
              <Input {...props} value={name} onChange={(event) => setName(event.target.value)} />
            )}
          </Field>
        )}
        {(!customer || !customer.phone) && (
          <Field label={t('usdtSale.phone')} required={mode === 'BROKER'}>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                inputMode="tel"
                value={phone}
                onChange={(event) => setPhone(normalizeDigits(event.target.value))}
              />
            )}
          </Field>
        )}
        <div className="sm:col-span-2">
          <Field label={t('usdtSale.notes')} hint={t('usdtSale.notesHint')}>
            {(props) => (
              <Input {...props} value={notes} onChange={(event) => setNotes(event.target.value)} />
            )}
          </Field>
        </div>
      </div>

      {done && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-success-subtle px-4 py-3 ring-1 ring-success-border">
          <span className="flex items-center gap-2 text-sm text-content">
            <span className="flex size-6 items-center justify-center rounded-full bg-success">
              <Check className="size-4 text-white" />
            </span>
            {t('usdtSale.recorded')}
            <span className="font-mono ltr-content">{done.reference}</span>
          </span>
          {canPrint && (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="ghost" icon={<Printer />} onClick={() => print(done.id)}>
                {t('transactions.printReceipt')}
              </Button>
              <ShareButton transactionId={done.id} />
            </span>
          )}
        </div>
      )}

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
        {t('usdtSale.record')}
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
        <section className="overflow-hidden rounded-2xl bg-surface ring-1 ring-border-subtle">
          <header className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
            <History className="size-4 text-primary-text" />
            <h3 className="text-sm font-semibold text-content">{t('usdtSale.recent')}</h3>
          </header>
          <ul className="divide-y divide-border-subtle">
            {recent.map((row) => {
              const gone = row.status === 'REVERSED';
              return (
                <li
                  key={row.id}
                  className={cn(
                    'flex items-center justify-between gap-3 px-4 py-2.5',
                    gone && 'bg-danger-subtle/20',
                  )}
                >
                  <div className="min-w-0">
                    <p
                      className={cn(
                        'ltr-content flex flex-wrap items-baseline gap-x-1.5 text-sm font-medium tabular-nums',
                        gone
                          ? 'text-content-tertiary line-through decoration-danger/60'
                          : 'text-content',
                      )}
                    >
                      <span>
                        {formatScaled(row.toAmount, USDT_DECIMALS)}{' '}
                        <span className="text-xs text-content-secondary">USDT</span>
                      </span>
                      <span className="text-content-tertiary">←</span>
                      <span>
                        {formatScaled(row.fromAmount, 2)}{' '}
                        <span className="text-xs text-content-secondary">{row.fromCurrency}</span>
                      </span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-content-tertiary">
                      <span className="tabular-nums ltr-content">
                        {new Date(row.createdAt).toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className="font-mono ltr-content">{row.reference}</span>
                      {row.counterpartyName && <span>{row.counterpartyName}</span>}
                      {gone && (
                        <span className="rounded bg-danger-subtle px-1.5 py-px font-medium text-danger-text">
                          {t('machine.deletedBadge')}
                        </span>
                      )}
                    </p>
                  </div>
                  {canPrint && (
                    <span className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => print(row.id)}
                        title={t('transactions.printReceipt')}
                        aria-label={t('transactions.printReceipt')}
                        className="flex size-10 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content sm:size-8"
                      >
                        <Printer className="size-4" />
                      </button>
                      <ShareButton transactionId={row.id} compact />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </form>
  );
}

/** The coins at the price, rounded half-up to the currency — as the server does. */
function totalOf(coins: bigint, price: bigint, decimals: number): bigint {
  if (coins <= 0n || price <= 0n) return 0n;
  const half = (value: bigint, by: bigint) => (value + by / 2n) / by;
  const exact = half(coins * price, 100000000n);
  const step = 10n ** BigInt(Math.max(0, 8 - decimals));
  return half(exact, step) * step;
}

/** Keeps only what an amount can be, at the given precision. */
function sanitiseAmount(raw: string, limit: number): string {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫٬]/g, '.')
    .replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  const fraction = rest.join('').slice(0, limit);
  const next = rest.length > 0 && limit > 0 ? `${whole}.${fraction}` : whole;
  return next.replace(/^0+(?=\d)/, '');
}

/** A typed decimal as the 1e8-scaled integer the rest of the system uses. */
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
