'use client';

import { useCallback, useEffect, useState } from 'react';
import { Scale, TriangleAlert } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, MoneyInput, Textarea } from '@/ui/form';
import { DateText, Money } from '@/ui/display';

/**
 * صندوق الفروقات — what the count did not match, waiting on a person.
 *
 * The screen is built around the one thing that matters about a difference: how
 * long it has been sitting there. A suspense balance is honest for a day or two
 * while the recordings are reviewed and dishonest after a month, and nothing in
 * the arithmetic can tell the two apart — so the age is on the row, and the
 * oldest one is called out at the top.
 *
 * The three ways to settle are shown together, each with what it means for the
 * office, because the choice is a judgement about money and not a status field:
 * two of them cost nothing and one of them is a loss.
 */

const RESOLUTIONS = ['MISCOUNT', 'CHARGED_TO_TELLER', 'COMPANY_LOSS'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

interface Difference {
  id: string;
  shift: string;
  tellerId: string;
  tellerNameEn: string;
  tellerNameAr: string;
  currency: string;
  decimals: number;
  amount: string;
  createdAt: string;
}

interface Debt {
  tellerId: string;
  tellerNameEn: string;
  tellerNameAr: string;
  currency: string;
  amount: string;
}

interface Shift {
  id: string;
  reference: string;
  tellerNameEn: string;
  tellerNameAr: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  differences: number;
}

interface Payload {
  oldestOpenAgeDays: number | null;
  open: Difference[];
  debts: Debt[];
  shifts: Shift[];
}

/** Past this, an unresolved difference has stopped being under review. */
const STALE_AFTER_DAYS = 7;

export function DifferencesView() {
  const { t, ln } = useLocale();
  const toast = useToast();

  const [data, setData] = useState<Payload | null>(null);
  const [ruling, setRuling] = useState<Difference | null>(null);
  const [choice, setChoice] = useState<Resolution>('MISCOUNT');
  const [note, setNote] = useState('');
  const [paying, setPaying] = useState<Debt | null>(null);
  const [payment, setPayment] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Payload>('/api/treasury/differences'));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : String(error));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const name = (row: { tellerNameEn: string; tellerNameAr: string }) => ln(row, 'tellerName');

  const ageOf = (iso: string) => {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return days <= 0 ? t('difference.today') : t('difference.days', { count: days });
  };

  const submitRuling = async () => {
    if (!ruling) return;
    setBusy(true);
    try {
      await api.post('/api/treasury/differences', {
        action: 'resolve',
        id: ruling.id,
        resolution: choice,
        note: note.trim() || null,
      });
      toast.success(t('difference.resolved'));
      setRuling(null);
      setNote('');
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const submitPayment = async () => {
    if (!paying) return;
    setBusy(true);
    try {
      await api.post('/api/treasury/differences', {
        action: 'settle',
        tellerId: paying.tellerId,
        currency: paying.currency,
        amount: payment,
      });
      toast.success(t('difference.settled'));
      setPaying(null);
      setPayment('');
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const stale = data?.oldestOpenAgeDays != null && data.oldestOpenAgeDays >= STALE_AFTER_DAYS;

  return (
    <div className="space-y-4">
      {stale && (
        <Alert tone="warning" icon={<TriangleAlert className="h-4 w-4" />}>
          {t('difference.ageingWarning', { count: data!.oldestOpenAgeDays! })}
        </Alert>
      )}

      {/* --- Waiting on a decision ------------------------------------- */}
      <Card>
        <CardHeader
          title={t('difference.open')}
          description={t('difference.openHint')}
          actions={
            data?.oldestOpenAgeDays != null && !stale ? (
              <Badge tone="neutral">
                {t('difference.ageing', { count: data.oldestOpenAgeDays })}
              </Badge>
            ) : null
          }
        />
        <CardBody className="p-0">
          {!data?.open.length ? (
            <EmptyState
              icon={<Scale className="h-6 w-6" />}
              title={t('difference.none')}
              description={t('difference.noneHint')}
            />
          ) : (
            <ul className="divide-y divide-border-base">
              {data.open.map((row) => {
                const amount = BigInt(row.amount);
                const short = amount > 0n;
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
                  >
                    <Badge tone={short ? 'danger' : 'success'}>
                      {short ? t('difference.short') : t('difference.over')}
                    </Badge>

                    <Money
                      value={short ? amount : -amount}
                      currency={row.currency}
                      decimals={row.decimals}
                      className="font-semibold"
                    />

                    <span className="text-content-secondary">{name(row)}</span>

                    <span className="text-content-tertiary text-xs">
                      {t('difference.shift')} {row.shift}
                    </span>

                    <span className="text-content-tertiary ms-auto text-xs">
                      {t('difference.age')} {ageOf(row.createdAt)}
                    </span>

                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setRuling(row);
                        setChoice('MISCOUNT');
                        setNote('');
                      }}
                    >
                      {t('difference.resolve')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* --- What tellers owe ------------------------------------------ */}
      <Card>
        <CardHeader title={t('difference.debts')} description={t('difference.debtsHint')} />
        <CardBody className="p-0">
          {!data?.debts.length ? (
            <EmptyState title={t('difference.noDebts')} />
          ) : (
            <ul className="divide-y divide-border-base">
              {data.debts.map((row) => (
                <li
                  key={`${row.tellerId}:${row.currency}`}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
                >
                  <span>{name(row)}</span>
                  <span className="text-content-tertiary text-xs">{t('difference.owes')}</span>
                  <Money value={row.amount} currency={row.currency} className="font-semibold" />
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ms-auto"
                    onClick={() => {
                      setPaying(row);
                      setPayment('');
                    }}
                  >
                    {t('difference.settle')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* --- Recent shifts --------------------------------------------- */}
      <Card>
        <CardHeader title={t('difference.shifts')} description={t('difference.shiftsHint')} />
        <CardBody className="p-0">
          {!data?.shifts.length ? (
            <EmptyState title={t('difference.noShifts')} />
          ) : (
            <ul className="divide-y divide-border-base">
              {data.shifts.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="font-mono text-xs">{row.reference}</span>
                  <span>{name(row)}</span>
                  <Badge tone={row.status === 'OPEN' ? 'primary' : 'neutral'}>
                    {row.status === 'OPEN' ? t('difference.shiftOpen') : t('difference.shiftClosed')}
                  </Badge>
                  <Badge tone={row.differences ? 'warning' : 'success'}>
                    {row.differences
                      ? t('difference.countDifferences', { count: row.differences })
                      : t('difference.clean')}
                  </Badge>
                  <span className="text-content-tertiary ms-auto text-xs">
                    <DateText value={row.closedAt ?? row.openedAt} withTime />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* --- Ruling ----------------------------------------------------- */}
      <Dialog
        open={ruling !== null}
        onClose={() => setRuling(null)}
        title={t('difference.resolve')}
        description={t('difference.resolveHint')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRuling(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submitRuling} loading={busy}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        {ruling && (
          <div className="space-y-3">
            <div className="bg-surface-sunken flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
              <Badge tone={BigInt(ruling.amount) > 0n ? 'danger' : 'success'}>
                {BigInt(ruling.amount) > 0n ? t('difference.short') : t('difference.over')}
              </Badge>
              <Money
                value={BigInt(ruling.amount) > 0n ? BigInt(ruling.amount) : -BigInt(ruling.amount)}
                currency={ruling.currency}
                decimals={ruling.decimals}
                className="font-semibold"
              />
              <span className="text-content-secondary">{name(ruling)}</span>
            </div>

            <div className="space-y-2">
              {RESOLUTIONS.map((option) => {
                // Nobody owes money that was found.
                const impossible = option === 'CHARGED_TO_TELLER' && BigInt(ruling.amount) < 0n;
                return (
                  <label
                    key={option}
                    className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${
                      choice === option ? 'border-primary-border bg-primary-subtle' : 'border-border-base'
                    } ${impossible ? 'pointer-events-none opacity-40' : ''}`}
                  >
                    <input
                      type="radio"
                      name="resolution"
                      className="mt-1"
                      checked={choice === option}
                      disabled={impossible}
                      onChange={() => setChoice(option)}
                    />
                    <span>
                      <span className="block font-medium">{t(`difference.resolution.${option}`)}</span>
                      <span className="text-content-tertiary block text-xs">
                        {t(`difference.resolution.${option}_HINT`)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>

            <Field label={t('difference.noteLabel')}>
              {(field) => (
                <Textarea
                  {...field}
                  rows={2}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              )}
            </Field>
          </div>
        )}
      </Dialog>

      {/* --- Payment ---------------------------------------------------- */}
      <Dialog
        open={paying !== null}
        onClose={() => setPaying(null)}
        title={t('difference.settle')}
        description={t('difference.settleHint')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPaying(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submitPayment} loading={busy} disabled={!payment}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        {paying && (
          <Field label={`${name(paying)} — ${paying.currency}`}>
            {(field) => (
              <MoneyInput
                {...field}
                value={payment}
                onValueChange={setPayment}
                currency={paying.currency}
              />
            )}
          </Field>
        )}
      </Dialog>
    </div>
  );
}
