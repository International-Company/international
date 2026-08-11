'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeftRight, Check, Plus, TriangleAlert, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { normalizeDigits } from '@/core/money/money';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select } from '@/ui/form';
import { DateText, Money } from '@/ui/display';
import type { TranslationKey } from '@/i18n/types';

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

  const fail = (caught: unknown) =>
    toast.error(
      t('errors.title'),
      caught instanceof ApiError
        ? t(caught.messageKey as never, caught.params as Record<string, string>) || caught.message
        : t('errors.generic'),
    );

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

          {currencies.map((currency) => (
            <Field
              key={currency.code}
              label={`${ln(currency as unknown as Record<string, unknown>, 'name')} (${currency.code})`}
              hint={currency.kind === 'CRYPTO' ? t('handover.allocatedHint') : undefined}
            >
              {(props) => (
                <Input
                  {...props}
                  dir="ltr"
                  inputMode="decimal"
                  value={amounts[currency.code] ?? ''}
                  placeholder="0"
                  onChange={(event) =>
                    setAmounts((current) => ({
                      ...current,
                      [currency.code]: sanitise(event.target.value, currency.decimals),
                    }))
                  }
                />
              )}
            </Field>
          ))}
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

            return (
              <Field
                key={line.id}
                label={`${line.currencyCode} — ${t('handover.declaredAmount', {
                  amount: format(line.amount, decimals),
                })}`}
                hint={t('handover.countedHint')}
                required
              >
                {(props) => (
                  <Input
                    {...props}
                    dir="ltr"
                    inputMode="decimal"
                    /* Never pre-filled with the declared figure: a count that
                       arrives already agreed is not a count. */
                    value={counted[key] ?? ''}
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
            );
          })}
        </div>
      </Dialog>

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
