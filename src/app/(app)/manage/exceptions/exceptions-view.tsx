'use client';

import { useCallback, useEffect, useState } from 'react';
import { Gavel, TriangleAlert } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, MoneyInput, Textarea } from '@/ui/form';
import { DateText, Money, Rate } from '@/ui/display';

/**
 * The manager's half of breaking a price.
 *
 * Built around one comparison and one number. The comparison is three rates on
 * one line — what the board says, what the teller wants, and what the office
 * pays for the currency — because the question is "are we still above cost?"
 * and a screen that shows only the first two turns it back into "does that seem
 * reasonable?". The number is what the concession costs at the amount it would
 * cover: a rate difference of two agurot reads as nothing, and the same
 * difference on ten thousand dollars does not.
 *
 * It reloads on a timer because the customer is standing at the counter while
 * this is open, and an approval nobody answers for four minutes is a refusal
 * that nobody had to say out loud.
 */

interface Pending {
  id: string;
  reference: string;
  tellerNameEn: string;
  tellerNameAr: string;
  fromCurrency: string;
  toCurrency: string;
  channel: string;
  maxFromAmount: string;
  boardRate: string;
  requestedRate: string;
  costRate: string | null;
  concession: string;
  aboveCost: boolean | null;
  reason: string | null;
  createdAt: string;
}

interface Decided {
  id: string;
  reference: string;
  status: string;
  tellerNameEn: string;
  tellerNameAr: string;
  approverNameEn: string | null;
  approverNameAr: string | null;
  fromCurrency: string;
  toCurrency: string;
  boardRate: string;
  approvedRate: string | null;
  costRate: string | null;
  transaction: string | null;
  createdAt: string;
}

const REFRESH_MS = 15_000;

export function ExceptionsView() {
  const { t, ln } = useLocale();
  const toast = useToast();

  const [pending, setPending] = useState<Pending[]>([]);
  const [recent, setRecent] = useState<Decided[]>([]);
  const [ruling, setRuling] = useState<Pending | null>(null);
  const [grantAt, setGrantAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ pending?: Pending[]; recent?: Decided[] }>(
        '/api/exchange/price-exceptions',
      );
      setPending(data.pending ?? []);
      setRecent(data.recent ?? []);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : String(error));
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const name = (row: { tellerNameEn: string; tellerNameAr: string }) => ln(row, 'tellerName');

  const decide = async (approve: boolean) => {
    if (!ruling) return;
    setBusy(true);
    try {
      await api.post('/api/exchange/price-exceptions', {
        action: 'decide',
        id: ruling.id,
        approve,
        rate: approve && grantAt ? grantAt : null,
        note: note.trim() || null,
      });
      toast.success(t(approve ? 'exception.approved' : 'exception.rejected'));
      setRuling(null);
      setNote('');
      setGrantAt('');
      await load();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  /** The three rates, side by side. Never two of them. */
  const Rates = ({ row }: { row: Pending | Decided }) => {
    const asked = 'requestedRate' in row ? row.requestedRate : row.approvedRate;
    return (
      <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-content-secondary text-xs">
          {t('exception.board')} <Rate value={row.boardRate} />
        </span>
        <span className="text-xs font-semibold">
          {t('exception.asked')} <Rate value={asked ?? '0'} />
        </span>
        <span className="text-content-secondary text-xs">
          {t('exception.cost')}{' '}
          {row.costRate ? <Rate value={row.costRate} /> : t('exception.costUnknown')}
        </span>
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {/* --- Waiting on a decision -------------------------------------- */}
      <Card>
        <CardHeader title={t('exception.waiting')} description={t('exception.waitingHint')} />
        <CardBody className="p-0">
          {pending.length === 0 ? (
            <EmptyState
              icon={<Gavel className="h-6 w-6" />}
              title={t('exception.none')}
              description={t('exception.noneHint')}
            />
          ) : (
            <ul className="divide-y divide-border-base">
              {pending.map((row) => (
                <li key={row.id} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono ltr-content text-xs">{row.reference}</span>
                    <span className="font-medium">{name(row)}</span>
                    <Badge tone="neutral">
                      {row.fromCurrency}/{row.toCurrency}
                    </Badge>
                    <Badge tone="neutral">
                      {t(`exception.channel.${row.channel === 'BROKER' ? 'BROKER' : 'CASH'}`)}
                    </Badge>
                    {row.aboveCost === null ? (
                      <Badge tone="warning">{t('exception.costUnknown')}</Badge>
                    ) : (
                      <Badge tone={row.aboveCost ? 'success' : 'danger'}>
                        {row.aboveCost ? t('exception.aboveCost') : t('exception.belowCost')}
                      </Badge>
                    )}
                    <span className="text-content-tertiary ms-auto text-xs">
                      <DateText value={row.createdAt} withTime />
                    </span>
                  </div>

                  <Rates row={row} />

                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-content-secondary text-xs">
                      {t('exception.upTo', {
                        amount: fmt(row.maxFromAmount),
                        currency: row.fromCurrency,
                      })}
                    </span>
                    <span className="text-xs">
                      {t('exception.concession')}{' '}
                      <Money value={row.concession} currency={row.toCurrency} className="font-semibold" />
                    </span>
                    {row.reason && (
                      <span className="text-content-tertiary text-xs">“{row.reason}”</span>
                    )}
                    <Button
                      size="sm"
                      variant="primary"
                      className="ms-auto"
                      onClick={() => {
                        setRuling(row);
                        setGrantAt('');
                        setNote('');
                      }}
                    >
                      {t('exception.approve')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* --- What was decided ------------------------------------------- */}
      <Card>
        <CardHeader title={t('exception.recent')} description={t('exception.recentHint')} />
        <CardBody className="p-0">
          {recent.length === 0 ? (
            <EmptyState title={t('exception.noneRecent')} />
          ) : (
            <ul className="divide-y divide-border-base">
              {recent.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="font-mono text-xs">{row.reference}</span>
                  <span>{name(row)}</span>
                  <Badge
                    tone={
                      row.status === 'USED'
                        ? 'success'
                        : row.status === 'APPROVED'
                          ? 'primary'
                          : row.status === 'REJECTED'
                            ? 'danger'
                            : 'neutral'
                    }
                  >
                    {t(`exception.status.${statusKey(row.status)}`)}
                  </Badge>
                  {row.approvedRate && <Rate value={row.approvedRate} />}
                  <span className="text-content-tertiary text-xs">
                    {row.transaction
                      ? t('exception.spentOn', { reference: row.transaction })
                      : row.status === 'APPROVED'
                        ? ''
                        : t('exception.unspent')}
                  </span>
                  <span className="text-content-tertiary ms-auto text-xs">
                    <DateText value={row.createdAt} withTime />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* --- The decision ------------------------------------------------ */}
      <Dialog
        open={ruling !== null}
        onClose={() => setRuling(null)}
        title={t('exception.approve')}
        description={t('exception.grantHint')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRuling(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => decide(false)} loading={busy}>
              {t('exception.reject')}
            </Button>
            <Button variant="primary" onClick={() => decide(true)} loading={busy}>
              {t('exception.approve')}
            </Button>
          </>
        }
      >
        {ruling && (
          <div className="space-y-3">
            {ruling.aboveCost === false && (
              <Alert tone="danger" icon={<TriangleAlert className="h-4 w-4" />}>
                {t('exception.belowCostWarning')}
              </Alert>
            )}
            {ruling.aboveCost === null && (
              <Alert tone="warning">{t('exception.costUnknownHint')}</Alert>
            )}

            <div className="bg-surface-sunken space-y-2 rounded-lg px-3 py-2">
              <Rates row={ruling} />
              <p className="text-xs">
                {t('exception.concession')}{' '}
                <Money value={ruling.concession} currency={ruling.toCurrency} className="font-semibold" />{' '}
                <span className="text-content-tertiary">
                  {t('exception.concessionHint', {
                    amount: fmt(ruling.maxFromAmount),
                    currency: ruling.fromCurrency,
                  })}
                </span>
              </p>
            </div>

            <Field label={t('exception.grantAt')} hint={t('exception.grantHint')}>
              {(field) => (
                <MoneyInput
                  {...field}
                  value={grantAt}
                  onValueChange={setGrantAt}
                  decimals={6}
                  placeholder={plain(ruling.requestedRate)}
                />
              )}
            </Field>

            <Field label={t('exception.decisionNote')}>
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
    </div>
  );
}

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'USED', 'EXPIRED', 'CANCELLED'] as const;
type Status = (typeof STATUSES)[number];

function statusKey(status: string): Status {
  return (STATUSES as readonly string[]).includes(status) ? (status as Status) : 'PENDING';
}

/** A scaled figure as plain digits, for a placeholder or an interpolated word. */
function plain(scaled: string, decimals = 6): string {
  return (Number(BigInt(scaled)) / 1e8).toFixed(decimals);
}

function fmt(scaled: string): string {
  return (Number(BigInt(scaled)) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
