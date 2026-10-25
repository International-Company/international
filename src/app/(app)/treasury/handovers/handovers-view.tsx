'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, Calculator, Check, FileText, Plus, TriangleAlert, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { normalizeDigits } from '@/core/money/money';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import type { TranslationKey } from '@/i18n/types';
import { cn } from '@/ui/utils';
import { DenominationCounter, hasNotes } from './denomination-counter';
import { CountRecordDialog, plain } from './count-record';

/**
 * التسليم — one screen for both sides of it.
 *
 * The manager and the teller do the same two things here, in opposite order: one
 * declares and the other counts. Building two screens would mean two ideas of
 * what a handover is, and they would drift; this shows each person the half they
 * are on, and the server decides which half that is.
 *
 * The counting form is the important part. It shows what the other side
 * declared and asks for what is actually in front of you — the two side by side,
 * because a screen that pre-fills the count with the declared figure is a screen
 * that gets agreed to without anybody counting.
 */

interface Line {
  id: string;
  currencyCode: string;
  kind: string;
  nature: string;
  amount: string;
  countedAmount: string | null;
  /** What the books say the teller holds — only while it waits to be counted. */
  expected?: string | null;
}

interface Handover {
  id: string;
  reference: string;
  direction: string;
  status: string;
  note: string | null;
  createdAt: string;
  confirmedAt: string | null;
  lines: Line[];
  teller: { id: string; fullNameEn: string; fullNameAr: string };
  createdBy: { fullNameEn: string; fullNameAr: string };
  confirmedBy: { fullNameEn: string; fullNameAr: string } | null;
}

interface Currency {
  code: string;
  nameEn: string;
  nameAr: string;
  decimals: number;
  kind: string;
}

export function HandoversView({
  tellers,
  currencies,
  permissions,
  userId,
}: {
  tellers: { id: string; fullNameEn: string; fullNameAr: string }[];
  currencies: Currency[];
  permissions: string[];
  userId: string;
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const isTreasury = permissions.includes('treasury.handover.manage');

  const [awaiting, setAwaiting] = useState<Handover[]>([]);
  const [recent, setRecent] = useState<Handover[]>([]);
  const [busy, setBusy] = useState(false);

  const [declaring, setDeclaring] = useState(false);
  const [teller, setTeller] = useState(tellers[0]?.id ?? '');
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const [counting, setCounting] = useState<Handover | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState<Handover | null>(null);

  /** Which line's note-by-note counter is open, keyed like `counted`. */
  const [noteCounter, setNoteCounter] = useState<string | null>(null);
  /** The count record being read. */
  const [reading, setReading] = useState<string | null>(null);

  /*
   * The teller's own figures, for handing back: what the books say he holds in
   * each currency, and what he owes the bank tonight. Shown in the declaration
   * so he hands back against the figure he will be counted on.
   */
  const [holdings, setHoldings] = useState<Record<string, string>>({});
  const [owed, setOwed] = useState<{ currency: string; amount: string }[]>([]);

  useEffect(() => {
    if (isTreasury) return;
    void api
      .get<{ holdings: { currency: string; kind: string; amount: string }[] }>('/api/treasury/shift')
      .then((data) =>
        setHoldings(
          Object.fromEntries(
            data.holdings
              .filter((row) => row.kind === 'CASH')
              .map((row) => [row.currency, row.amount]),
          ),
        ),
      )
      .catch(() => setHoldings({}));
    void api
      .get<{ days: { owedAtEnd: { currency: string; amount: string }[] }[] }>('/api/my/days?days=1')
      .then((data) => setOwed(data.days[0]?.owedAtEnd ?? []))
      .catch(() => setOwed([]));
  }, [isTreasury, declaring]);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ awaiting: Handover[]; recent: Handover[] }>(
        '/api/treasury/handovers',
      );
      setAwaiting(result.awaiting);
      setRecent(result.recent);
    } catch {
      setAwaiting([]);
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const fail = (caught: unknown) => {
    // A refusal is headed as one; only a real fault gets the apology.
    const { title, body } = describeFailure(caught, t as never);
    toast.error(title, body);
  };

  const declare = async () => {
    const lines = currencies
      .map((currency) => ({
        currency: currency.code,
        // USDT never changes hands: it is a balance the teller is allowed to
        // draw on, so it is acknowledged rather than counted.
        nature: currency.kind === 'CRYPTO' ? ('ALLOCATED' as const) : ('COUNTED' as const),
        amount: (amounts[currency.code] ?? '').trim(),
      }))
      .filter((line) => line.amount !== '' && Number(line.amount) > 0);

    if (lines.length === 0) return;

    setBusy(true);
    try {
      await api.post('/api/treasury/handovers', {
        action: 'declare',
        direction: isTreasury ? 'TO_TELLER' : 'TO_TREASURY',
        tellerId: isTreasury ? teller : userId,
        lines,
      });
      toast.success(t('handover.declared'));
      setDeclaring(false);
      setAmounts({});
      void load();
      router.refresh();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!counting) return;
    setBusy(true);
    try {
      const result = await api.post<{ status: string }>('/api/treasury/handovers', {
        action: 'confirm',
        id: counting.id,
        counted: counting.lines
          .filter((line) => line.nature === 'COUNTED')
          .map((line) => ({
            currency: line.currencyCode,
            kind: line.kind,
            amount: (counted[`${line.currencyCode}:${line.kind}`] ?? '0').trim() || '0',
          })),
      });

      if (result.status === 'DISPUTED') toast.error(t('handover.disputedTitle'), t('handover.disputedBody'));
      else toast.success(t('handover.confirmed'));

      setCounting(null);
      setCounted({});
      void load();
      router.refresh();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (reason: string) => {
    if (!cancelling) return;
    setBusy(true);
    try {
      await api.post('/api/treasury/handovers', { action: 'cancel', id: cancelling.id, reason });
      toast.success(t('handover.cancelled'));
      setCancelling(null);
      void load();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  };

  const decimalsOf = (code: string) => currencies.find((c) => c.code === code)?.decimals ?? 2;

  return (
    <div className="space-y-4">
      {/* ============ What I am holding ============ */}
      {!isTreasury && <MyShift t={t} />}

      {/* ============ What the management wrote to me ============ */}
      <StaffNotes t={t} ln={ln} />

      {/* ============ Waiting on me ============ */}
      {awaiting.length > 0 ? (
        awaiting.map((handover) => (
          <Card key={handover.id} className="ring-2 ring-primary">
            <CardHeader
              title={t('handover.awaitingTitle')}
              description={t('handover.awaitingBody', {
                who: ln(handover.createdBy, 'fullName'),
                reference: handover.reference,
              })}
              actions={
                <Button
                  variant="primary"
                  icon={<Check />}
                  onClick={() => {
                    setCounted({});
                    setCounting(handover);
                  }}
                >
                  {t('handover.count')}
                </Button>
              }
            />
            <CardBody>
              <LineTable lines={handover.lines} decimalsOf={decimalsOf} t={t} />
            </CardBody>
          </Card>
        ))
      ) : (
        <Alert tone="neutral">{t('handover.nothingWaiting')}</Alert>
      )}

      {/* ============ Declare one ============ */}
      <div className="flex justify-end">
        <Button variant="secondary" icon={<Plus />} onClick={() => setDeclaring(true)}>
          {isTreasury ? t('handover.declareToTeller') : t('handover.declareToTreasury')}
        </Button>
      </div>

      {/* ============ History ============ */}
      <Card>
        <CardHeader title={t('handover.recent')} description={t('handover.recentHint')} />
        <CardBody>
          {recent.length === 0 ? (
            <EmptyState
              icon={<ArrowLeftRight />}
              title={t('handover.noneYet')}
              description={t('handover.noneYetHint')}
            />
          ) : (
            <ul className="divide-y divide-border-subtle rounded-lg border border-border-base">
              {recent.map((handover) => (
                <li key={handover.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <StatusBadge status={handover.status} t={t} />
                  <span className="font-mono text-xs text-content-tertiary ltr-content">
                    {handover.reference}
                  </span>
                  <span className="text-sm text-content">
                    {handover.direction === 'TO_TELLER'
                      ? t('handover.toTeller', { who: ln(handover.teller, 'fullName') })
                      : t('handover.toTreasury', { who: ln(handover.teller, 'fullName') })}
                  </span>
                  <span className="text-xs text-content-tertiary">
                    {handover.lines
                      .map((line) => `${format(line.amount, decimalsOf(line.currencyCode))} ${line.currencyCode}`)
                      .join(' · ')}
                  </span>

                  <span className="ms-auto flex items-center gap-2 text-xs text-content-tertiary">
                    <DateText value={handover.createdAt} withTime />
                    {/* The count, currency by currency — once there is one. */}
                    {handover.direction === 'TO_TREASURY' && handover.status !== 'CANCELLED' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<FileText />}
                        onClick={() => setReading(handover.id)}
                      >
                        {t('handover.record')}
                      </Button>
                    )}
                    {isTreasury && (handover.status === 'PENDING' || handover.status === 'DISPUTED') && (
                      <Button size="sm" variant="ghost" icon={<X />} onClick={() => setCancelling(handover)}>
                        {t('common.cancel')}
                      </Button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* ============ Declaring ============ */}
      <Dialog
        open={declaring}
        onClose={() => setDeclaring(false)}
        title={isTreasury ? t('handover.declareToTeller') : t('handover.declareToTreasury')}
        description={t('handover.declareHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeclaring(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void declare()}>
              {t('handover.declare')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {isTreasury && (
            <Field label={t('handover.teller')} required>
              {(props) => (
                <Select
                  {...props}
                  value={teller}
                  onChange={(event) => setTeller(event.target.value)}
                  options={tellers.map((person) => ({
                    value: person.id,
                    label: ln(person, 'fullName'),
                  }))}
                />
              )}
            </Field>
          )}

          {/*
            What he owes the bank tonight, beside what he hands back: the two
            things the evening asks of a teller, in one place.
          */}
          {!isTreasury && owed.some((entry) => BigInt(entry.amount) !== 0n) && (
            <Alert tone="warning" title={t('handover.owedBank')}>
              <span className="ltr-content tabular-nums">
                {owed
                  .map((entry) => `${plain(entry.amount, decimalsOf(entry.currency))} ${entry.currency}`)
                  .join(' · ')}
              </span>
            </Alert>
          )}

          {currencies.map((currency) => {
            const held = !isTreasury ? holdings[currency.code] : undefined;
            const entered = amounts[currency.code] ?? '';
            // What would be booked as a shortage if he hands back this much.
            const short =
              held !== undefined && entered !== ''
                ? BigInt(held) - toScaled(entered)
                : null;
            const counterKey = `declare:${currency.code}`;
            return (
              <Field
                key={currency.code}
                label={`${ln(currency as unknown as Record<string, unknown>, 'name')} (${currency.code})`}
                hint={currency.kind === 'CRYPTO' ? t('handover.allocatedHint') : undefined}
              >
                {(props) => (
                  <div className="space-y-1.5">
                    <Input
                      {...props}
                      dir="ltr"
                      inputMode="decimal"
                      value={entered}
                      placeholder="0"
                      onChange={(event) =>
                        setAmounts((current) => ({
                          ...current,
                          [currency.code]: sanitise(event.target.value, currency.decimals),
                        }))
                      }
                    />
                    {held !== undefined && (
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-content-secondary">
                          {t('handover.inSystem')}{' '}
                          <span className="font-semibold tabular-nums ltr-content">
                            {plain(held, currency.decimals)}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="text-primary-text hover:underline"
                          onClick={() =>
                            setAmounts((current) => ({
                              ...current,
                              [currency.code]: plain(held, currency.decimals).replace(/,/g, ''),
                            }))
                          }
                        >
                          {t('handover.fillExpected')}
                        </button>
                        {currency.kind !== 'CRYPTO' && hasNotes(currency.code) && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-primary-text hover:underline"
                            onClick={() =>
                              setNoteCounter(noteCounter === counterKey ? null : counterKey)
                            }
                          >
                            <Calculator className="size-3.5" />
                            {t('handover.byNotes')}
                          </button>
                        )}
                        {short !== null && short > 0n && currency.kind !== 'CRYPTO' && (
                          <span className="font-medium text-danger-text">
                            {t('handover.willBookShort', {
                              amount: `${plain(short.toString(), currency.decimals)} ${currency.code}`,
                            })}
                          </span>
                        )}
                      </div>
                    )}
                    {noteCounter === counterKey && (
                      <DenominationCounter
                        currency={currency.code}
                        decimals={currency.decimals}
                        onUse={(amount) => {
                          setAmounts((current) => ({ ...current, [currency.code]: amount }));
                          setNoteCounter(null);
                        }}
                      />
                    )}
                  </div>
                )}
              </Field>
            );
          })}
        </div>
      </Dialog>

      {/* ============ Counting ============ */}
      <Dialog
        open={counting !== null}
        onClose={() => setCounting(null)}
        title={t('handover.count')}
        description={t('handover.countHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCounting(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" icon={<Check />} loading={busy} onClick={() => void confirm()}>
              {t('handover.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {counting?.lines.map((line) => {
            const key = `${line.currencyCode}:${line.kind}`;
            const decimals = decimalsOf(line.currencyCode);

            // Acknowledged, not counted: nothing changed hands, so there is
            // nothing to enter and nothing that can disagree.
            if (line.nature === 'ALLOCATED') {
              return (
                <div key={line.id} className="rounded-xl bg-surface-sunken px-3 py-2.5">
                  <p className="text-xs text-content-tertiary">{t('handover.allocated')}</p>
                  <p className="text-sm font-semibold text-content ltr-content">
                    {format(line.amount, decimals)} {line.currencyCode}
                  </p>
                </div>
              );
            }

            /*
             * As the count is typed: does it agree with what was declared (if
             * not, the handover is held as a dispute and nothing moves), and
             * how does it stand against the books (any gap is booked to the
             * differences balance when it is confirmed). Both, because they are
             * different questions with different consequences.
             */
            const entry = counted[key] ?? '';
            const typed = entry !== '' ? toScaled(entry) : null;
            const matchesDeclared = typed !== null && typed === BigInt(line.amount);
            const gap =
              typed !== null && line.expected != null ? BigInt(line.expected) - typed : null;
            const counterKey = `count:${key}`;

            return (
              <div key={line.id} className="space-y-1.5 rounded-xl ring-1 ring-border-subtle p-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="text-sm font-semibold ltr-content">{line.currencyCode}</span>
                  {line.expected != null && (
                    <span className="text-content-secondary">
                      {t('handover.inSystem')}{' '}
                      <span className="font-semibold tabular-nums ltr-content">
                        {plain(line.expected, decimals)}
                      </span>
                    </span>
                  )}
                  <span className="text-content-secondary">
                    {t('handover.declaredAmount', { amount: format(line.amount, decimals) })}
                  </span>
                </div>
                <Field label={t('handover.countedHint')} required>
                  {(props) => (
                    <Input
                      {...props}
                      dir="ltr"
                      inputMode="decimal"
                      /* Never pre-filled with the declared figure: a count that
                         arrives already agreed is not a count. */
                      value={entry}
                      placeholder="0"
                      onChange={(event) =>
                        setCounted((current) => ({
                          ...current,
                          [key]: sanitise(event.target.value, decimals),
                        }))
                      }
                    />
                  )}
                </Field>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  {hasNotes(line.currencyCode) && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-primary-text hover:underline"
                      onClick={() => setNoteCounter(noteCounter === counterKey ? null : counterKey)}
                    >
                      <Calculator className="size-3.5" />
                      {t('handover.byNotes')}
                    </button>
                  )}
                  {typed !== null && (
                    <span
                      className={cn(
                        'font-medium',
                        matchesDeclared ? 'text-success-text' : 'text-danger-text',
                      )}
                    >
                      {matchesDeclared ? t('handover.matchesDeclared') : t('handover.notDeclared')}
                    </span>
                  )}
                  {gap !== null && (
                    <span
                      className={cn(
                        'font-medium',
                        gap === 0n
                          ? 'text-success-text'
                          : gap > 0n
                            ? 'text-danger-text'
                            : 'text-warning-text',
                      )}
                    >
                      {gap === 0n
                        ? t('handover.recordExact')
                        : gap > 0n
                          ? t('handover.recordShort', {
                              amount: `${plain(gap.toString(), decimals)} ${line.currencyCode}`,
                            })
                          : t('handover.recordOver', {
                              amount: `${plain((-gap).toString(), decimals)} ${line.currencyCode}`,
                            })}
                    </span>
                  )}
                </div>
                {noteCounter === counterKey && (
                  <DenominationCounter
                    currency={line.currencyCode}
                    decimals={decimals}
                    onUse={(amount) => {
                      setCounted((current) => ({ ...current, [key]: amount }));
                      setNoteCounter(null);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </Dialog>

      <CountRecordDialog id={reading} onClose={() => setReading(null)} decimalsOf={decimalsOf} />

      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        onConfirm={() => void cancel(t('handover.cancelReason'))}
        title={`${t('common.cancel')} — ${cancelling?.reference ?? ''}`}
        message={t('handover.cancelHint')}
        confirmLabel={t('common.cancel')}
        cancelLabel={t('common.close')}
        tone="danger"
        loading={busy}
      />
    </div>
  );
}

function LineTable({
  lines,
  decimalsOf,
  t,
}: {
  lines: Line[];
  decimalsOf: (code: string) => number;
  t: (key: never) => string;
}) {
  return (
    <ul className="divide-y divide-border-subtle rounded-lg border border-border-base">
      {lines.map((line) => (
        <li key={line.id} className="flex items-center gap-3 px-3 py-2 text-sm">
          <span className="font-medium text-content ltr-content">{line.currencyCode}</span>
          {line.nature === 'ALLOCATED' && (
            <Badge tone="neutral">{t('handover.allocated' as never)}</Badge>
          )}
          <span className="ms-auto tabular-nums text-content ltr-content">
            {format(line.amount, decimalsOf(line.currencyCode))}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StatusBadge({ status, t }: { status: string; t: (key: never) => string }) {
  const tone =
    status === 'CONFIRMED'
      ? 'success'
      : status === 'DISPUTED'
        ? 'danger'
        : status === 'CANCELLED'
          ? 'neutral'
          : 'warning';

  return (
    <Badge tone={tone as 'success' | 'danger' | 'neutral' | 'warning'}>
      {status === 'DISPUTED' && <TriangleAlert className="size-3" />}
      {t(`handover.status.${status}` as never)}
    </Badge>
  );
}

/** Keeps only what an amount can be, at the currency's own precision. */
function sanitise(raw: string, limit: number): string {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫٬]/g, '.')
    .replace(/[^\d.]/g, '');

  const [whole = '', ...rest] = cleaned.split('.');
  const fraction = rest.join('').slice(0, limit);
  const next = rest.length > 0 && limit > 0 ? `${whole}.${fraction}` : whole;
  return next.replace(/^0+(?=\d)/, '');
}

/** A typed amount at the 1e8 scale the server speaks. */
function toScaled(value: string): bigint {
  const [whole = '0', fraction = ''] = value.trim().replace(/,/g, '').split('.');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) return 0n;
  return BigInt(whole || '0') * 100_000_000n + BigInt((fraction + '00000000').slice(0, 8));
}

/** Renders a 1e8-scaled string at a currency's own precision. */
function format(scaled: string, decimals: number): string {
  const value = BigInt(scaled || '0');
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(9, '0');

  const grouped = Number(digits.slice(0, -8)).toLocaleString('en-US');
  const fraction = digits.slice(-8).slice(0, decimals);
  const text = decimals > 0 ? `${grouped}.${fraction}` : grouped;
  return negative ? `-${text}` : text;
}

/**
 * The teller's own drawer, and the shift it belongs to.
 *
 * Shown only to the teller, because it is the only balance they act on: every
 * note they hand a customer comes out of this, and tonight it has to be empty.
 * The treasury has its own screen for its own money.
 */
function MyShift({ t }: { t: (key: TranslationKey, params?: Record<string, string | number>) => string }) {
  const [state, setState] = useState<{
    shift: { reference: string; openedAt: string } | null;
    holdings: { currency: string; kind: string; decimals: number; amount: string }[];
  } | null>(null);

  useEffect(() => {
    void api
      .get<NonNullable<typeof state>>('/api/treasury/shift')
      .then(setState)
      .catch(() => setState(null));
  }, []);

  if (!state) return null;

  if (!state.shift) {
    return (
      <Alert tone="neutral" title={t('handover.noShift')}>
        {t('handover.noShiftHint')}
      </Alert>
    );
  }

  // Cash only. A teller instructing a bank transfer draws on the office's claim,
  // which is not theirs to count.
  const cash = state.holdings.filter((row) => row.kind === 'CASH');
  const anything = cash.some((row) => BigInt(row.amount) !== 0n);

  return (
    <Card>
      <CardHeader
        title={`${t('handover.myShift')} — ${state.shift.reference}`}
        description={t('handover.myShiftHint')}
      />
      <CardBody>
        {anything ? (
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {cash
              .filter((row) => BigInt(row.amount) !== 0n)
              .map((row) => (
                <Money
                  key={row.currency}
                  value={row.amount}
                  currency={row.currency}
                  decimals={row.decimals}
                  className="text-base font-semibold"
                />
              ))}
          </div>
        ) : (
          <p className="text-sm text-content-secondary">{t('handover.emptyDrawer')}</p>
        )}
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A word from the management
// ---------------------------------------------------------------------------

/**
 * Notes written to this person, on the screen they open every morning.
 *
 * Shown where the shift begins rather than on a page of its own, because a
 * message on a page nobody visits is a message that was not sent. Reading it is
 * recorded — not as agreement, only as delivery, so "nobody told me" has an
 * answer either way.
 */
function StaffNotes({
  t,
  ln,
}: {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  ln: (record: object, baseKey: string) => string;
}) {
  const toast = useToast();
  const [notes, setNotes] = useState<
    { id: string; tone: string; body: string; authorEn: string; authorAr: string }[]
  >([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<{ notes: typeof notes }>('/api/me/notes')
      .then((data) => setNotes(data.notes))
      .catch(() => setNotes([]));
  }, []);

  if (notes.length === 0) return null;

  const acknowledge = async () => {
    setBusy(true);
    try {
      await api.post('/api/me/notes', {});
      toast.success(t('evaluation.acknowledged'));
      setNotes([]);
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : t('errors.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="ring-warning-border ring-2">
      <CardHeader title={t('evaluation.forYou')} description={t('evaluation.forYouHint')} />
      <CardBody className="space-y-3">
        {notes.map((note) => (
          <div key={note.id} className="space-y-1">
            <Badge
              tone={note.tone === 'WARNING' ? 'danger' : note.tone === 'PRAISE' ? 'success' : 'neutral'}
            >
              {t(`evaluation.tone.${note.tone === 'WARNING' ? 'WARNING' : note.tone === 'PRAISE' ? 'PRAISE' : 'NOTE'}`)}
            </Badge>
            <p className="text-sm">{note.body}</p>
            <p className="text-content-tertiary text-xs">{ln(note, 'author')}</p>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={acknowledge} loading={busy}>
          {t('evaluation.acknowledge')}
        </Button>
      </CardBody>
    </Card>
  );
}
