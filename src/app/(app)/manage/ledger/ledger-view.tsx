'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDownLeft, ArrowUpRight, Lock, Pencil, TrendingDown, TrendingUp } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { normalizeDigits } from '@/core/money/money';
import { Alert, Badge, Button, Card, CardBody, CardHeader, StatTile } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input } from '@/ui/form';
import { DateText } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * دفتر الأستاذ — one day, read from the top down.
 *
 * The order is the argument. What the office is worth comes first, because that
 * is the measure; what it holds comes next, because that is what the figure is
 * made of; the owner's own money and the day's costs come after, because they
 * are what had to be removed before the result meant anything; and the margins
 * written on the tickets come last, marked as indicators, because that is
 * exactly what they are.
 *
 * A day that is still open says so on every figure. It is a running total, which
 * is what a manager wants at four in the afternoon and what nobody should quote
 * in a report — so the screen never lets the two be confused.
 */

interface PositionLine {
  drawerId: string;
  currencyCode: string;
  kind: string;
  ownerKey: string;
  tellerId: string | null;
  balance: string;
  cutoffRate: string;
  worth: string;
}

interface FundingLine {
  id: string;
  direction: string;
  amount: string;
  category: string | null;
  note: string | null;
  createdAt: string;
  drawer: { currencyCode: string; kind: string };
  createdBy: { fullNameEn: string; fullNameAr: string };
}

interface Day {
  base: string;
  date: string;
  status: string;
  frozen: boolean;
  position: PositionLine[];
  missing: string[];
  worth: string;
  openingWorth: string;
  openingDate: string | null;
  funding: { ownerIn: string; ownerOut: string; expense: string; correction: string };
  result: string;
  resultBeforeExpenses: string;
  revaluation: string;
  tradingResult: string;
  margins: { type: string; count: number; margin: string }[];
  rates: { currency: string; rate: string; setOn: string | null }[];
  fundingLines: FundingLine[];
}

/** The base currency is always shown to two places; it is a total, not a rate. */
const BASE_DECIMALS = 2;

export function LedgerView({
  day,
  currencies,
  permissions,
  tellerNames,
}: {
  day: Day;
  currencies: { code: string; nameEn: string; nameAr: string; decimals: number }[];
  permissions: string[];
  /** Whose drawer is whose, so a line can say it in a name rather than an id. */
  tellerNames: Record<string, string>;
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  /*
   * The same total, split by the state the money is in. A shekel in the safe, a
   * shekel in a teller's drawer and a shekel suspended in the differences
   * balance are all worth one shekel and none of them is the same thing.
   */
  const whereIsIt = day.position.reduce(
    (totals, line) => {
      const worth = BigInt(line.worth);
      if (line.kind === 'DIFFERENCE') totals.differences += worth;
      else if (line.tellerId !== null) totals.tellers += worth;
      else totals.treasury += worth;
      return totals;
    },
    { treasury: 0n, tellers: 0n, differences: 0n },
  );

  const [editing, setEditing] = useState<string | null>(null);
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);

  const canApprove = permissions.includes('ledger.cutoff.manage');
  const decimalsOf = (code: string) => currencies.find((c) => c.code === code)?.decimals ?? 2;

  const change = BigInt(day.worth) - BigInt(day.openingWorth);
  const result = BigInt(day.result);

  const openRate = (currency: string) => {
    const current = day.rates.find((entry) => entry.currency === currency);
    setRate(current ? plain(current.rate, 4) : '');
    setEditing(currency);
  };

  const approve = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await api.post('/api/manage/ledger', {
        date: day.date,
        currency: editing,
        rate: rate.trim(),
      });
      toast.success(t('ledger.rateApproved'), editing);
      setEditing(null);
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? t(cause.messageKey as never, cause.params as Record<string, string>) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* A currency the branch holds that nobody has priced. The close refuses
          while this is true, so it is said here rather than at the close. */}
      {day.missing.length > 0 && (
        <Alert tone="danger" title={t('ledger.missingTitle')}>
          {t('ledger.missingBody', { currencies: day.missing.join('، ') })}
        </Alert>
      )}

      {!day.frozen && (
        <Alert tone="neutral" title={t('ledger.liveTitle')}>
          {t('ledger.liveBody')}
        </Alert>
      )}

      {/* ============ What the office is worth ============ */}
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-content-secondary">{t('ledger.worth')}</p>
              <p className="mt-1 text-4xl font-bold tabular-nums tracking-tight text-content ltr-content">
                {format(day.worth, BASE_DECIMALS)}{' '}
                <span className="text-lg font-medium text-content-tertiary">{day.base}</span>
              </p>
            </div>

            <div className="text-end">
              <p className="text-xs font-medium text-content-secondary">
                {t('ledger.result')}
                {day.frozen ? '' : ` — ${t('ledger.running')}`}
              </p>
              <p
                className={cn(
                  'mt-1 flex items-center justify-end gap-2 text-3xl font-bold tabular-nums tracking-tight ltr-content',
                  result < 0n ? 'text-danger-text' : 'text-success-text',
                )}
              >
                {result < 0n ? (
                  <TrendingDown className="size-6" />
                ) : (
                  <TrendingUp className="size-6" />
                )}
                {format(day.result, BASE_DECIMALS)}
              </p>
            </div>
          </div>

          {/* How the figure was arrived at, in the order it is arrived at. */}
          <dl className="grid gap-x-6 gap-y-2 rounded-xl bg-surface-sunken p-4 sm:grid-cols-2">
            <Line
              label={
                day.openingDate
                  ? t('ledger.opening', { date: day.openingDate })
                  : t('ledger.openingNone')
              }
              value={day.openingWorth}
              base={day.base}
            />
            <Line label={t('ledger.change')} value={change.toString()} base={day.base} signed />
            <Line label={t('ledger.ownerIn')} value={day.funding.ownerIn} base={day.base} />
            <Line label={t('ledger.ownerOut')} value={day.funding.ownerOut} base={day.base} />
            <Line
              label={t('ledger.beforeExpenses')}
              value={day.resultBeforeExpenses}
              base={day.base}
              signed
            />
            <Line label={t('ledger.expenses')} value={day.funding.expense} base={day.base} />
          </dl>

          {/*
            The manager's own distinction: how much of the day came from the
            position moving, and how much from the window trading. Both are real
            profit; only one of them anybody at the counter did anything about.
          */}
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            <Line
              label={t('ledger.revaluation')}
              value={day.revaluation}
              base={day.base}
              signed
              hint={t('ledger.revaluationHint')}
            />
            <Line
              label={t('ledger.tradingResult')}
              value={day.tradingResult}
              base={day.base}
              signed
              hint={t('ledger.tradingResultHint')}
            />
            {BigInt(day.funding.correction) !== 0n && (
              <Line
                label={t('ledger.correction')}
                value={day.funding.correction}
                base={day.base}
                signed
                hint={t('ledger.correctionHint')}
              />
            )}
          </dl>
        </CardBody>
      </Card>

      {/* ============ Where it is ============ */}
      {/*
        The office is worth what it holds plus what it has lent to the people at
        its own counters plus what is suspended in the differences balance. Three
        very different states of the same money, and a total that shows only the
        sum invites the manager to read it as cash in the safe.
      */}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label={t('ledger.inTreasury')} value={`${format(whereIsIt.treasury.toString(), BASE_DECIMALS)} ${day.base}`} />
        <StatTile
          label={t('ledger.withTellers')}
          value={`${format(whereIsIt.tellers.toString(), BASE_DECIMALS)} ${day.base}`}
          hint={t('ledger.withTellersHint')}
        />
        <StatTile
          label={t('ledger.suspended')}
          value={`${format(whereIsIt.differences.toString(), BASE_DECIMALS)} ${day.base}`}
          hint={t('ledger.suspendedHint')}
          tone={whereIsIt.differences === 0n ? undefined : 'warning'}
        />
      </div>

      {/* ============ The position ============ */}
      <Card>
        <CardHeader
          title={t('ledger.position')}
          description={day.frozen ? t('ledger.positionFrozen') : t('ledger.positionLive')}
          actions={
            day.frozen ? (
              <Badge tone="neutral">
                <Lock className="size-3" />
                {t('ledger.closed')}
              </Badge>
            ) : undefined
          }
        />
        <CardBody>
          <div className="overflow-x-auto rounded-lg border border-border-base">
            <table className="w-full min-w-[34rem] border-collapse">
              <thead>
                <tr className="bg-surface-sunken text-xs text-content-secondary">
                  <th className="px-3 py-2 text-start font-medium">{t('ledger.holding')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('drawers.title')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('ledger.cutoffRate')}</th>
                  <th className="px-3 py-2 text-end font-medium">
                    {t('ledger.worthIn', { currency: day.base })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {day.position.map((line) => (
                  <tr key={line.drawerId} className="border-t border-border-subtle text-sm">
                    <td className="px-3 py-2">
                      <span className="font-medium text-content ltr-content">
                        {line.currencyCode}
                      </span>
                      <span className="ms-2 text-xs text-content-tertiary">
                        {t(kindLabel(line.kind))}
                      </span>
                      {line.tellerId && (
                        <span className="ms-2 text-xs text-content-secondary">
                          {tellerNames[line.tellerId] ?? ''}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums ltr-content">
                      {format(line.balance, decimalsOf(line.currencyCode))}
                    </td>
                    <td className="px-3 py-2 text-end tabular-nums text-content-secondary ltr-content">
                      {format(line.cutoffRate, 4)}
                    </td>
                    <td className="px-3 py-2 text-end font-semibold tabular-nums ltr-content">
                      {format(line.worth, BASE_DECIMALS)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border-base bg-surface-sunken text-sm">
                  <td className="px-3 py-2 font-medium" colSpan={3}>
                    {t('ledger.worth')}
                  </td>
                  <td className="px-3 py-2 text-end font-bold tabular-nums ltr-content">
                    {format(day.worth, BASE_DECIMALS)} {day.base}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </CardBody>
      </Card>

      {/* ============ The rates it is valued at ============ */}
      <Card>
        <CardHeader title={t('ledger.rates')} description={t('ledger.ratesHint')} />
        <CardBody>
          <ul className="divide-y divide-border-subtle rounded-lg border border-border-base">
            {currencies.map((currency) => {
              const entry = day.rates.find((row) => row.currency === currency.code);
              const isBase = currency.code === day.base;

              return (
                <li
                  key={currency.code}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm"
                >
                  <span className="font-medium text-content ltr-content">{currency.code}</span>
                  <span className="text-xs text-content-tertiary">
                    {ln(currency as unknown as Record<string, unknown>, 'name')}
                  </span>

                  <span className="ms-auto flex items-center gap-3">
                    {entry ? (
                      <>
                        <span className="tabular-nums text-content ltr-content">
                          1 {currency.code} = {format(entry.rate, 4)} {day.base}
                        </span>
                        {/* A rate carried from an earlier day is marked as
                            carried. Silence meant agreement, not attention. */}
                        {entry.setOn && entry.setOn.slice(0, 10) !== day.date && (
                          <Badge tone="neutral">
                            {t('ledger.rolledFrom')} <DateText value={entry.setOn} />
                          </Badge>
                        )}
                      </>
                    ) : (
                      <span className="text-danger-text">{t('ledger.noRate')}</span>
                    )}

                    {canApprove && !isBase && !day.frozen && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Pencil />}
                        onClick={() => openRate(currency.code)}
                      >
                        {t('ledger.approve')}
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardBody>
      </Card>

      {/* ============ The owner's money, and the day's costs ============ */}
      {day.fundingLines.length > 0 && (
        <Card>
          <CardHeader title={t('ledger.funding')} description={t('ledger.fundingHint')} />
          <CardBody>
            <ul className="divide-y divide-border-subtle rounded-lg border border-border-base">
              {day.fundingLines.map((line) => {
                const outgoing = line.direction === 'OUT';
                return (
                  <li key={line.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span
                      className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-full',
                        outgoing ? 'bg-danger-subtle' : 'bg-success-subtle',
                      )}
                    >
                      {outgoing ? (
                        <ArrowUpRight className="size-3 text-danger-text" />
                      ) : (
                        <ArrowDownLeft className="size-3 text-success-text" />
                      )}
                    </span>

                    <span className="tabular-nums text-content ltr-content">
                      {format(line.amount, decimalsOf(line.drawer.currencyCode))}{' '}
                      {line.drawer.currencyCode}
                    </span>

                    <Badge tone={line.category === 'EXPENSE' ? 'warning' : 'neutral'}>
                      {line.category
                        ? t(categoryLabel(line.category))
                        : t('ledger.categoryUnknown')}
                    </Badge>

                    {line.note && (
                      <span className="text-xs text-content-tertiary">{line.note}</span>
                    )}

                    <span className="ms-auto text-xs text-content-tertiary">
                      <DateText value={line.createdAt} withTime />
                    </span>
                    <span className="text-xs text-content-tertiary">
                      {ln(line.createdBy, 'fullName')}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      )}

      {/* ============ Indicators ============ */}
      {day.margins.length > 0 && (
        <Card>
          <CardHeader title={t('ledger.margins')} description={t('ledger.marginsHint')} />
          <CardBody>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {day.margins.map((entry) => (
                <Line
                  key={entry.type}
                  label={`${t(`transactions.type.${entry.type}` as never)} · ${t('ledger.count', { count: String(entry.count) })}`}
                  value={entry.margin}
                  base={day.base}
                  signed
                />
              ))}
              <Line
                label={t('ledger.marginTotal')}
                value={day.margins
                  .reduce((total, entry) => total + BigInt(entry.margin), 0n)
                  .toString()}
                base={day.base}
                signed
              />
            </dl>
          </CardBody>
        </Card>
      )}

      {/* ============ Approving a rate ============ */}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={`${t('ledger.approve')} — ${editing ?? ''}`}
        description={t('ledger.approveHint', { base: day.base, currency: editing ?? '' })}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!rate.trim()}
              onClick={() => void approve()}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Field label={t('ledger.cutoffRate')} required>
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              value={rate}
              onChange={(event) => setRate(sanitise(event.target.value))}
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}

/** One figure with its label, in the base currency. */
function Line({
  label,
  value,
  base,
  signed,
  hint,
}: {
  label: string;
  value: string;
  base: string;
  signed?: boolean;
  hint?: string;
}) {
  const amount = BigInt(value);
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle py-1.5 last:border-0">
      <dt className="min-w-0 text-sm text-content-secondary">
        {label}
        {hint && <span className="block text-xs text-content-tertiary">{hint}</span>}
      </dt>
      <dd
        className={cn(
          'shrink-0 text-sm font-semibold tabular-nums ltr-content',
          signed && amount < 0n ? 'text-danger-text' : 'text-content',
        )}
      >
        {format(value, 2)} {base}
      </dd>
    </div>
  );
}

function kindLabel(kind: string): 'drawers.broker' | 'drawers.correspondent' | 'drawers.cash' {
  if (kind === 'BROKER') return 'drawers.broker';
  if (kind === 'CORRESPONDENT') return 'drawers.correspondent';
  return 'drawers.cash';
}

function categoryLabel(category: string) {
  return `ledger.category.${category}` as
    | 'ledger.category.OWNER_IN'
    | 'ledger.category.OWNER_OUT'
    | 'ledger.category.EXPENSE'
    | 'ledger.category.TRANSFER'
    | 'ledger.category.CORRECTION';
}

/** Keeps only what a rate can be. */
function sanitise(raw: string): string {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫٬]/g, '.')
    .replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  return rest.length > 0 ? `${whole}.${rest.join('').slice(0, 8)}` : whole;
}

/** Renders a 1e8-scaled string at a given precision, grouped. */
function format(scaled: string, decimals: number): string {
  const value = BigInt(scaled || '0');
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(9, '0');

  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, decimals);

  const grouped = Number(whole).toLocaleString('en-US');
  const text = decimals > 0 ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${text}` : text;
}

/** The same, ungrouped, for an editable field. */
function plain(scaled: string, decimals: number): string {
  const digits = BigInt(scaled || '0').toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, decimals);
  return decimals > 0 ? `${whole}.${fraction}` : whole;
}
