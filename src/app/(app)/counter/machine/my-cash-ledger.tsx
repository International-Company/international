'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, ClipboardList, Wallet } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { formatDate } from '@/i18n/format';
import { api, queryString } from '@/lib/api-client';
import { Alert, Badge, Button } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input } from '@/ui/form';
import { describeFailure } from '@/lib/failure';
import { normalizeDigits } from '@/core/money/money';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * جرد عملياتي — the teller's own box for a day, from zero.
 *
 * Opening at zero, then what he bought and sold, then every deal with the
 * notes it moved and the box after it, then the closing figure the drawer is
 * counted against. The running box is the point: when the count is off, the
 * line where it goes wrong is the deal to look at.
 */

interface Amount {
  currency: string;
  amount: string;
}

interface Entry {
  id: string;
  reference: string;
  type: string;
  at: string;
  side: 'BUY' | 'SELL' | 'CROSS' | 'OTHER';
  foreign: Amount | null;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  cashIn: Amount[];
  cashOut: Amount[];
  running: Amount[];
  reversal: boolean;
  reversed: boolean;
}

interface Ledger {
  opening: Amount[];
  openingSet: boolean;
  currencies: { code: string; decimals: number }[];
  closing: Amount[];
  traded: { currency: string; bought: string; sold: string; buys: number; sells: number }[];
  entries: Entry[];
}

type Filter = 'ALL' | 'BUY' | 'SELL';

const dayInput = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

/** Shekels per unit of the foreign side, read off the amounts themselves. */
function priceOf(entry: Entry): string | null {
  const from = Number(entry.fromAmount);
  const to = Number(entry.toAmount);
  if (!from || !to) return null;
  if (entry.side === 'BUY') return (to / from).toFixed(4);
  if (entry.side === 'SELL') return (from / to).toFixed(4);
  return null;
}

export function MyCashLedger({
  refreshKey,
  day: fixedDay,
  className,
}: {
  refreshKey?: string;
  /** A day chosen elsewhere on the page; without it the section picks its own. */
  day?: string;
  className?: string;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [ownDay, setDay] = useState(() => dayInput(new Date()));
  const day = fixedDay ?? ownDay;
  const isToday = day === dayInput(new Date());

  // --- Opening the box ----------------------------------------------------------
  const [opening, setOpening] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    const from = new Date(year, month - 1, date);
    const to = new Date(year, month - 1, date, 23, 59, 59, 999);
    setLoading(true);
    try {
      setLedger(
        await api.get<Ledger>(
          `/api/my/cash-ledger${queryString({ from: from.toISOString(), to: to.toISOString(), day })}`,
        ),
      );
    } catch {
      setLedger(null);
    } finally {
      setLoading(false);
    }
  }, [day]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const entries = (ledger?.entries ?? []).filter(
    (entry) => filter === 'ALL' || entry.side === filter,
  );

  const sideBadge = (entry: Entry) => {
    if (entry.side === 'BUY') return <Badge tone="success">{t('cashLedger.buy')}</Badge>;
    if (entry.side === 'SELL') return <Badge tone="primary">{t('cashLedger.sell')}</Badge>;
    return <Badge tone="neutral">{t(`transactions.type.${entry.type}` as never)}</Badge>;
  };

  const amounts = (list: Amount[], tone?: string) =>
    list.length === 0 ? (
      <span className="text-content-tertiary">—</span>
    ) : (
      list.map((entry) => (
        <span key={entry.currency} className={cn('block', tone)}>
          <Money value={entry.amount} currency={entry.currency} />
        </span>
      ))
    );

  const startOpening = () => {
    if (!ledger) return;
    const current = new Map(ledger.opening.map((entry) => [entry.currency, entry.amount]));
    setOpening(
      Object.fromEntries(
        ledger.currencies.map((currency) => {
          const scaled = current.get(currency.code);
          return [currency.code, scaled && scaled !== '0' ? plainAmount(scaled) : ''];
        }),
      ),
    );
  };

  const saveOpening = async () => {
    if (!opening) return;
    setSaving(true);
    try {
      await api.post('/api/my/cash-ledger', {
        day,
        lines: Object.entries(opening).map(([currency, amount]) => ({
          currency,
          amount: amount.trim() || '0',
        })),
      });
      toast.success(t('cashLedger.openingSaved'));
      setOpening(null);
      await load();
    } catch (caught) {
      const { title, body } = describeFailure(caught, t as never);
      toast.error(title, body);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className={cn(
        'mt-6 space-y-4 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle',
        className,
      )}
    >
      {/* --- Heading and the day ---------------------------------------- */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-content">
            <ClipboardList className="size-5 text-primary-text" />
            {t('cashLedger.title')}
          </h2>
          <p className="text-xs text-content-secondary">{t('cashLedger.hint')}</p>
        </div>
        {fixedDay === undefined && <DayNavigator value={day} onChange={setDay} />}
      </header>

      {/* The day starts with the box: asked for, plainly, until it is given. */}
      {ledger && !ledger.openingSet && isToday && (
        <Alert tone="warning" icon={<Wallet />} title={t('cashLedger.openingAsk')}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('cashLedger.openingAskHint')}</span>
            <Button size="sm" onClick={startOpening}>
              {t('cashLedger.openingSet')}
            </Button>
          </div>
        </Alert>
      )}

      {loading && !ledger ? (
        <p className="py-6 text-center text-sm text-content-tertiary">{t('common.loading')}</p>
      ) : !ledger || (ledger.entries.length === 0 && !ledger.openingSet) ? (
        <p className="py-6 text-center text-sm text-content-tertiary">{t('cashLedger.empty')}</p>
      ) : (
        <>
          {/* --- Opening, traded, closing ------------------------------------ */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-surface-sunken p-3">
              <p className="text-xs font-medium text-content-secondary">
                {t('cashLedger.opening')}
              </p>
              <div className="mt-1 text-lg font-bold tabular-nums">{amounts(ledger.opening)}</div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-content-tertiary">
                  {ledger.openingSet ? t('cashLedger.openingByYou') : t('cashLedger.openingHint')}
                </p>
                <Button size="sm" variant="ghost" onClick={startOpening}>
                  {ledger.openingSet ? t('cashLedger.openingEdit') : t('cashLedger.openingSet')}
                </Button>
              </div>
            </div>

            <div className="rounded-xl bg-surface-sunken p-3">
              <p className="text-xs font-medium text-content-secondary">{t('cashLedger.traded')}</p>
              {ledger.traded.length === 0 ? (
                <p className="mt-1 text-sm text-content-tertiary">—</p>
              ) : (
                <dl className="mt-1 space-y-1.5 text-sm">
                  {ledger.traded.map((row) => (
                    <div key={row.currency} className="space-y-0.5">
                      <div className="flex justify-between gap-2">
                        <dt className="text-success-text">
                          {t('cashLedger.bought', { count: row.buys })}
                        </dt>
                        <dd className="font-semibold tabular-nums">
                          <Money value={row.bought} currency={row.currency} />
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-primary-text">
                          {t('cashLedger.sold', { count: row.sells })}
                        </dt>
                        <dd className="font-semibold tabular-nums">
                          <Money value={row.sold} currency={row.currency} />
                        </dd>
                      </div>
                    </div>
                  ))}
                </dl>
              )}
            </div>

            <div className="rounded-xl bg-primary-subtle p-3 ring-1 ring-primary/30">
              <p className="text-xs font-medium text-content-secondary">
                {t('cashLedger.closing')}
              </p>
              <div className="mt-1 text-lg font-bold tabular-nums">{amounts(ledger.closing)}</div>
              <p className="mt-1 text-[11px] text-content-tertiary">
                {t('cashLedger.closingHint')}
              </p>
            </div>
          </div>

          {/* --- The deals, filtered ------------------------------------------ */}
          <div className="flex gap-1 rounded-full bg-surface-sunken p-1">
            {(['ALL', 'BUY', 'SELL'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFilter(option)}
                className={cn(
                  'flex-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors',
                  filter === option
                    ? 'bg-surface text-content shadow-sm'
                    : 'text-content-secondary hover:text-content',
                )}
              >
                {t(`cashLedger.filter.${option}`)}
              </button>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr className="bg-surface-sunken text-xs text-content-secondary">
                  <th className="px-2 py-2 text-start font-medium">{t('cashLedger.colTime')}</th>
                  <th className="px-2 py-2 text-start font-medium">{t('cashLedger.colDeal')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colAmount')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colPrice')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colIn')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colOut')}</th>
                  <th className="px-2 py-2 text-end font-medium">{t('cashLedger.colBox')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const struck = entry.reversed || entry.reversal;
                  return (
                    <tr
                      key={entry.id}
                      className={cn(
                        'border-t border-border-subtle align-top',
                        struck && 'bg-danger-subtle/20',
                      )}
                    >
                      <td className="px-2 py-2 tabular-nums ltr-content">
                        {new Date(entry.at).toLocaleTimeString('en-GB', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap items-center gap-1">
                          {sideBadge(entry)}
                          {entry.reversal && (
                            <Badge tone="danger">{t('cashLedger.reversal')}</Badge>
                          )}
                          {entry.reversed && (
                            <Badge tone="danger">{t('machine.deletedBadge')}</Badge>
                          )}
                        </div>
                        <span className="mt-0.5 block font-mono text-[11px] text-content-tertiary ltr-content">
                          {entry.reference}
                        </span>
                      </td>
                      <td
                        className={cn(
                          'px-2 py-2 text-end font-semibold tabular-nums',
                          struck && 'text-content-tertiary line-through',
                        )}
                      >
                        {entry.foreign ? (
                          <Money value={entry.foreign.amount} currency={entry.foreign.currency} />
                        ) : (
                          <Money value={entry.fromAmount} currency={entry.fromCurrency} />
                        )}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums ltr-content">
                        {priceOf(entry) ?? '—'}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">
                        {amounts(entry.cashIn, 'text-success-text')}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">
                        {amounts(entry.cashOut, 'text-danger-text')}
                      </td>
                      <td className="px-2 py-2 text-end text-xs font-semibold tabular-nums">
                        {amounts(entry.running)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* --- Opening the box: one field per cash currency --------------------- */}
      <Dialog
        open={opening !== null}
        onClose={() => setOpening(null)}
        title={t('cashLedger.openingTitle')}
        description={t('cashLedger.openingDialogHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpening(null)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button loading={saving} onClick={() => void saveOpening()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {opening && ledger && (
          <div className="grid gap-3 sm:grid-cols-2">
            {ledger.currencies.map((currency) => (
              <Field key={currency.code} label={currency.code}>
                {(props) => (
                  <Input
                    {...props}
                    dir="ltr"
                    inputMode="decimal"
                    placeholder="0"
                    value={opening[currency.code] ?? ''}
                    onChange={(event) =>
                      setOpening((current) => ({
                        ...(current ?? {}),
                        [currency.code]: sanitiseAmount(event.target.value, currency.decimals),
                      }))
                    }
                  />
                )}
              </Field>
            ))}
          </div>
        )}
      </Dialog>
    </section>
  );
}

/** A local day, from its `YYYY-MM-DD` key. */
function parseDay(value: string): Date {
  const [year, month, date] = value.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date);
}

/**
 * The day being counted: the previous and next day one tap either side, the
 * day itself spelled out — weekday, date, month and year — and a calendar
 * behind it for any day further back. Never past today: there is nothing to
 * count in a day that has not happened.
 */
function DayNavigator({ value, onChange }: { value: string; onChange: (day: string) => void }) {
  const { t, locale } = useLocale();
  const picker = useRef<HTMLInputElement>(null);
  const today = dayInput(new Date());
  const isToday = value === today;

  const shift = (days: number) => {
    const date = parseDay(value);
    date.setDate(date.getDate() + days);
    const next = dayInput(date);
    if (next <= today) onChange(next);
  };

  const openCalendar = () => {
    const input = picker.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus();
      input.click();
    }
  };

  const step =
    'flex size-9 shrink-0 items-center justify-center rounded-full text-content-secondary transition-colors hover:bg-surface-sunken hover:text-content disabled:pointer-events-none disabled:opacity-30';

  return (
    <div className="flex items-center gap-1 rounded-full bg-surface p-1 ring-1 ring-border-subtle">
      {/* In Arabic the earlier day is to the right, as the page reads. */}
      <button
        type="button"
        onClick={() => shift(-1)}
        className={step}
        title={t('cashLedger.previousDay')}
        aria-label={t('cashLedger.previousDay')}
      >
        <ChevronRight className="size-4 ltr:rotate-180" />
      </button>

      <div className="relative">
        <button
          type="button"
          onClick={openCalendar}
          className="flex min-w-44 items-center justify-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium text-content transition-colors hover:bg-surface-sunken"
          aria-label={t('cashLedger.day')}
        >
          <CalendarDays className="size-4 text-primary-text" />
          <span className="tabular-nums">
            {formatDate(parseDay(value), locale, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </span>
          {isToday && (
            <span className="rounded-full bg-primary-subtle px-2 py-px text-[11px] font-semibold text-primary-text">
              {t('cashLedger.today')}
            </span>
          )}
        </button>
        {/* The browser's own calendar, kept out of sight and opened from here. */}
        <input
          ref={picker}
          type="date"
          value={value}
          max={today}
          onChange={(event) => event.target.value && onChange(event.target.value)}
          tabIndex={-1}
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0"
        />
      </div>

      <button
        type="button"
        onClick={() => shift(1)}
        disabled={isToday}
        className={step}
        title={t('cashLedger.nextDay')}
        aria-label={t('cashLedger.nextDay')}
      >
        <ChevronLeft className="size-4 ltr:rotate-180" />
      </button>

      {!isToday && (
        <button
          type="button"
          onClick={() => onChange(today)}
          className="rounded-full px-3 py-1.5 text-xs font-semibold text-primary-text transition-colors hover:bg-primary-subtle"
        >
          {t('cashLedger.backToToday')}
        </button>
      )}
    </div>
  );
}

/** A 1e8-scaled figure as a plain decimal for an input, without trailing zeros. */
function plainAmount(scaled: string): string {
  const value = BigInt(scaled);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** Digits and one decimal point, at most `limit` places after it. */
function sanitiseAmount(raw: string, limit: number): string {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫٬]/g, '.')
    .replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  const fraction = rest.join('').slice(0, limit);
  const next = rest.length > 0 && limit > 0 ? `${whole}.${fraction}` : whole;
  return next.replace(/^0+(?=\d)/, '');
}
