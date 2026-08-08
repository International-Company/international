'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, ArrowRight, Check, Clock, Pencil, Plus, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput, Select } from '@/ui/form';
import { DateText, Rate } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * The rate board.
 *
 * Built around a single question: can the counter trade right now? Every pair
 * the tools need has a row whether or not a rate exists, because the pair with
 * no rate is the one stopping the machine, and a table that only lists what has
 * been published hides exactly that.
 *
 * The rest is what a desk actually watches: the spread it is earning, how old
 * the quote is, and who put it up. A rate published this morning and a rate
 * published on Tuesday look identical in a table of numbers, and only one of
 * them is safe to trade on.
 */

interface BoardRow {
  id: string;
  baseCode: string;
  quoteCode: string;
  buyRate: string;
  sellRate: string;
  midRate: string;
  spread: string;
  effectiveFrom: string;
  source: string | null;
  baseName: { en: string; ar: string };
  quoteName: { en: string; ar: string };
}

interface HistoryRow {
  id: string;
  baseCode: string;
  quoteCode: string;
  buyRate: string;
  sellRate: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdBy: { fullNameEn: string; fullNameAr: string } | null;
}

interface Coverage {
  pair: string;
  from: string;
  to: string;
  rateId: string | null;
  /** The stored pair that prices this one — itself, or its opposite. */
  servedBy: string | null;
}

/** Anything older than this is called out rather than left to be noticed. */
const STALE_AFTER_HOURS = 12;

export function RatesView({
  board,
  history,
  currencies,
  coverage,
  canManage,
}: {
  board: BoardRow[];
  history: HistoryRow[];
  currencies: { code: string; nameEn: string; nameAr: string; decimals: number }[];
  coverage: Coverage[];
  canManage: boolean;
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [editing, setEditing] = useState<{ base: string; quote: string } | null>(null);
  const [buyRate, setBuyRate] = useState('');
  const [sellRate, setSellRate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const byPair = useMemo(
    () => new Map(board.map((row) => [`${row.baseCode}/${row.quoteCode}`, row])),
    [board],
  );

  const missing = coverage.filter((entry) => entry.rateId === null);

  const open = (base: string, quote: string) => {
    const current = byPair.get(`${base}/${quote}`);
    setError(null);
    setBuyRate(current ? decimal(current.buyRate, 4) : '');
    setSellRate(current ? decimal(current.sellRate, 4) : '');
    setNote('');
    setEditing({ base, quote });
  };

  const publish = async () => {
    if (!editing) return;
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/exchange/rates', {
        baseCode: editing.base,
        quoteCode: editing.quote,
        buyRate,
        sellRate,
        note: note.trim() || undefined,
      });
      toast.success(t('rates.published'), `${editing.base}/${editing.quote}`);
      setEditing(null);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? t(caught.messageKey as never, caught.params as Record<string, string>) || caught.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  // The spread the desk is quoting, as a share of the mid — the figure that is
  // comparable across pairs, which the absolute difference is not.
  const spreadPercent = (row: BoardRow): number => {
    const mid = Number(BigInt(row.midRate)) / 1e8;
    const spread = Number(BigInt(row.spread)) / 1e8;
    return mid === 0 ? 0 : (spread / mid) * 100;
  };

  const hoursSince = (iso: string): number => (Date.now() - new Date(iso).getTime()) / 3_600_000;

  const shownHistory = filter
    ? history.filter((row) => `${row.baseCode}/${row.quoteCode}` === filter)
    : history;

  return (
    <div className="space-y-4">
      {/* --- What is stopping the counter -------------------------------- */}
      {missing.length > 0 && (
        <Alert tone="danger" icon={<AlertTriangle />} title={t('rates.missingTitle')}>
          <p>{t('rates.missingBody')}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {missing.map((entry) => (
              <button
                key={entry.pair}
                type="button"
                onClick={() => canManage && open(entry.from, entry.to)}
                disabled={!canManage}
                className="rounded-[var(--radius-control)] border border-danger px-2 py-1 font-mono text-xs text-danger-text ltr-content transition-colors enabled:hover:bg-danger-subtle"
              >
                {entry.pair}
              </button>
            ))}
          </div>
        </Alert>
      )}

      {/* --- The pairs the tools need ------------------------------------ */}
      <Card>
        <CardHeader
          title={t('rates.current')}
          description={t('rates.coverageHint')}
          actions={
            canManage && (
              <Button
                variant="primary"
                size="sm"
                icon={<Plus />}
                onClick={() => open(currencies[0]?.code ?? 'USD', currencies[1]?.code ?? 'ILS')}
              >
                {t('rates.publish')}
              </Button>
            )
          }
        />

        {coverage.length === 0 ? (
          <EmptyState title={t('rates.noPairs')} description={t('rates.noPairsHint')} />
        ) : (
          <ul className="divide-y divide-border-base">
            {coverage.map((entry) => {
              // The row that actually prices this pair, which for an inverted
              // pair is the opposite direction's.
              const row = entry.servedBy ? byPair.get(entry.servedBy) : undefined;
              const inverted = Boolean(entry.servedBy) && entry.servedBy !== entry.pair;
              const age = row ? hoursSince(row.effectiveFrom) : null;
              const stale = age !== null && age > STALE_AFTER_HOURS;

              return (
                <li
                  key={entry.pair}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4"
                >
                  {/* The pair */}
                  <div className="flex min-w-0 items-center gap-2 sm:w-40">
                    <span className="font-mono text-sm font-semibold text-content ltr-content">
                      {entry.from}
                    </span>
                    <ArrowRight className="size-3 shrink-0 text-content-tertiary rtl:rotate-180" />
                    <span className="font-mono text-sm font-semibold text-content ltr-content">
                      {entry.to}
                    </span>
                    {inverted && <Badge tone="neutral">{t('rates.inverted')}</Badge>}
                  </div>

                  {row ? (
                    <>
                      <div className="flex-1">
                        <div className="grid grid-cols-3 gap-3">
                          <Figure label={t('rates.buyRate')} value={<Rate value={row.buyRate} />} />
                          <Figure label={t('rates.sellRate')} value={<Rate value={row.sellRate} />} />
                          <Figure
                            label={t('rates.spread')}
                            value={
                              <span className="ltr-content">
                                <Rate value={row.spread} />
                                <span className="ms-1 text-xs text-content-tertiary">
                                  ({spreadPercent(row).toFixed(2)}%)
                                </span>
                              </span>
                            }
                          />
                        </div>

                        {/* These figures belong to the stored pair, not to this
                            direction — saying so is the difference between a
                            useful row and a misleading one. */}
                        {inverted && (
                          <p className="mt-1 text-xs text-content-tertiary">
                            {t('rates.servedBy', { pair: entry.servedBy ?? '' })}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-2 sm:w-52 sm:justify-end">
                        <span
                          className={cn(
                            'flex items-center gap-1 text-xs',
                            stale ? 'text-warning-text' : 'text-content-tertiary',
                          )}
                        >
                          <Clock className="size-3" />
                          <DateText value={row.effectiveFrom} relative />
                        </span>
                        {stale && <Badge tone="warning">{t('rates.stale')}</Badge>}
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t('rates.update')}
                            onClick={() => open(row.baseCode, row.quoteCode)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex flex-1 items-center justify-between gap-3">
                      <span className="text-sm text-danger-text">{t('rates.noRateForPair')}</span>
                      {canManage && (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Plus />}
                          onClick={() => open(entry.from, entry.to)}
                        >
                          {t('rates.publish')}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* --- Everything published, newest first -------------------------- */}
      <Card>
        <CardHeader
          title={t('rates.history')}
          description={t('rates.historyHint')}
          actions={
            <Select
              options={[
                { value: '', label: t('rates.allPairs') },
                ...[...new Set(history.map((row) => `${row.baseCode}/${row.quoteCode}`))].map(
                  (pair) => ({ value: pair, label: pair }),
                ),
              ]}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="sm:w-40"
            />
          }
        />

        {shownHistory.length === 0 ? (
          <CardBody>
            <p className="py-6 text-center text-sm text-content-secondary">{t('common.noResults')}</p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-base bg-surface-sunken">
                  <Th>{t('rates.pair')}</Th>
                  <Th align="end">{t('rates.buyRate')}</Th>
                  <Th align="end">{t('rates.sellRate')}</Th>
                  <Th align="end" hideOnMobile>
                    {t('rates.effectiveFrom')}
                  </Th>
                  <Th align="end" hideOnMobile>
                    {t('rates.effectiveTo')}
                  </Th>
                  <Th hideOnMobile>{t('transactions.createdBy')}</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-base">
                {shownHistory.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5 font-mono text-sm text-content ltr-content">
                      {row.baseCode}/{row.quoteCode}
                      {row.effectiveTo === null && (
                        <Badge tone="success" className="ms-2">
                          {t('rates.live')}
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-end text-sm text-content">
                      <Rate value={row.buyRate} />
                    </td>
                    <td className="px-4 py-2.5 text-end text-sm text-content">
                      <Rate value={row.sellRate} />
                    </td>
                    <td className="hidden px-4 py-2.5 text-end text-xs text-content-tertiary sm:table-cell">
                      <DateText value={row.effectiveFrom} withTime />
                    </td>
                    <td className="hidden px-4 py-2.5 text-end text-xs text-content-tertiary sm:table-cell">
                      {row.effectiveTo ? <DateText value={row.effectiveTo} withTime /> : '—'}
                    </td>
                    <td className="hidden px-4 py-2.5 text-xs text-content-secondary sm:table-cell">
                      {row.createdBy ? ln(row.createdBy, 'fullName') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* --- Publish ------------------------------------------------------ */}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={
          editing
            ? `${t('rates.publish')} — ${editing.base}/${editing.quote}`
            : t('rates.publish')
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              icon={<Check />}
              loading={busy}
              disabled={!buyRate || !sellRate}
              onClick={() => void publish()}
            >
              {t('rates.publish')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}

          {editing && (
            <div className="flex gap-2">
              <Field label={t('rates.pair')} className="flex-1">
                {(props) => (
                  <Select
                    {...props}
                    options={currencies.map((c) => ({ value: c.code, label: `${c.code} — ${ln(c, 'name')}` }))}
                    value={editing.base}
                    onChange={(event) => setEditing({ ...editing, base: event.target.value })}
                  />
                )}
              </Field>
              <Field label="&nbsp;" className="flex-1">
                {(props) => (
                  <Select
                    {...props}
                    options={currencies.map((c) => ({ value: c.code, label: `${c.code} — ${ln(c, 'name')}` }))}
                    value={editing.quote}
                    onChange={(event) => setEditing({ ...editing, quote: event.target.value })}
                  />
                )}
              </Field>
            </div>
          )}

          <Field label={t('rates.buyRate')} hint={t('rates.buyHint')} required>
            {(props) => (
              <MoneyInput {...props} value={buyRate} onValueChange={setBuyRate} decimals={6} />
            )}
          </Field>

          <Field label={t('rates.sellRate')} hint={t('rates.sellHint')} required>
            {(props) => (
              <MoneyInput {...props} value={sellRate} onValueChange={setSellRate} decimals={6} />
            )}
          </Field>

          {/* Computed as the operator types, because a spread the wrong way
              round is the one mistake here that costs money on every trade. */}
          <SpreadPreview buy={buyRate} sell={sellRate} />

          <Field label={t('rates.note')}>
            {(props) => (
              <Input {...props} value={note} onChange={(event) => setNote(event.target.value)} />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-content-tertiary">{label}</p>
      <p className="font-mono text-sm text-content">{value}</p>
    </div>
  );
}

function Th({
  children,
  align,
  hideOnMobile,
}: {
  children: React.ReactNode;
  align?: 'end';
  hideOnMobile?: boolean;
}) {
  return (
    <th
      className={cn(
        'px-4 py-2 text-xs font-medium text-content-secondary',
        align === 'end' ? 'text-end' : 'text-start',
        hideOnMobile && 'hidden sm:table-cell',
      )}
    >
      {children}
    </th>
  );
}

/** Live spread, and a plain refusal when the two sides are the wrong way round. */
function SpreadPreview({ buy, sell }: { buy: string; sell: string }) {
  const { t } = useLocale();

  const buyValue = Number(buy);
  const sellValue = Number(sell);
  if (!buy || !sell || !Number.isFinite(buyValue) || !Number.isFinite(sellValue)) return null;

  if (sellValue < buyValue) {
    return (
      <Alert tone="danger" icon={<X />}>
        {t('rates.invertedSpreadWarning')}
      </Alert>
    );
  }

  const mid = (buyValue + sellValue) / 2;
  const spread = sellValue - buyValue;
  const percent = mid === 0 ? 0 : (spread / mid) * 100;

  return (
    <div className="rounded-[var(--radius-control)] bg-surface-sunken p-3">
      <div className="flex items-center justify-between text-sm">
        <span className="text-content-secondary">{t('rates.spread')}</span>
        <span className="font-mono text-content ltr-content">
          {spread.toFixed(4)} ({percent.toFixed(2)}%)
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-xs">
        <span className="text-content-tertiary">{t('rates.midRate')}</span>
        <span className="font-mono text-content-secondary ltr-content">{mid.toFixed(4)}</span>
      </div>
    </div>
  );
}

/** Renders a 1e8-scaled string for an input the operator will edit. */
function decimal(scaled: string, places: number): string {
  const value = BigInt(scaled || '0');
  const digits = value.toString().padStart(9, '0');
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).slice(0, places).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
