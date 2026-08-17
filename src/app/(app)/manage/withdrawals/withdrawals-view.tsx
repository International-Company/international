'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Inbox, Loader2, RefreshCw, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure, say } from '@/lib/failure';
import { Alert, Button, Card, CardBody } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Textarea } from '@/ui/form';
import { DateText, Money } from '@/ui/display';

/**
 * The queue of coins waiting on a signature.
 *
 * ## What the manager is actually deciding
 *
 * Not whether the trade was priced well — that is already done and the
 * customer has already paid. He is deciding whether **this amount may leave
 * for this address**, which is the one step nothing later can undo. So the
 * address is the largest thing on the row, shown whole and split so it can be
 * read against the customer's own screen rather than glanced at.
 *
 * ## Why a refusal asks for a reason
 *
 * Refusing reverses the sale, and somebody then has to hand money back to a
 * person who is standing there. The teller cannot do that without a sentence
 * to say, and the customer is owed one.
 *
 * ## Why it polls
 *
 * The manager leaves this open. A send recorded downstairs should appear
 * without anybody thinking to refresh, because the customer attached to it is
 * waiting the whole time it does not.
 */

interface Waiting {
  id: string;
  reference: string;
  createdAt: string;
  fromCurrency: string;
  fromAmount: string;
  toAmount: string;
  payoutAddress: string | null;
  counterpartyName: string | null;
  createdBy: { id: string; fullNameEn: string; fullNameAr: string };
  customer: { fullNameEn: string; fullNameAr: string } | null;
  payoutWallet: { label: string; labelAr: string; network: string } | null;
}

/** What the program will do when the button is pressed. */
interface Sending {
  ready: boolean;
  address: string | null;
  perTransfer: string;
  perDay: string;
  sentToday: string;
}

const POLL_MS = 20_000;

/** A scaled figure as a plain two-decimal number, for a sentence. */
function plain(scaled: string): string {
  return (Number(BigInt(scaled)) / 1e8).toFixed(2);
}

export function WithdrawalsView() {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [rows, setRows] = useState<Waiting[] | null>(null);
  const [sending, setSending] = useState<Sending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusing, setRefusing] = useState<Waiting | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ rows: Waiting[]; sending: Sending }>('/api/usdt/withdrawals');
      setRows(data.rows);
      setSending(data.sending);
    } catch {
      setRows((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const decide = async (row: Waiting, approve: boolean, note?: string) => {
    setBusy(row.id);
    try {
      const outcome = await api.post<{ txHash: string | null; sendIssue: string | null }>(
        `/api/usdt/withdrawals/${row.id}`,
        { approve, note: note ?? null },
      );

      /*
       * Three different things can have happened and they must not share one
       * message: refused, released and sent, or released and still waiting for
       * a person. The last one used to read exactly like the middle one.
       */
      if (!approve) {
        toast.success(t('release.refused'), row.reference);
      } else if (outcome.txHash) {
        toast.success(t('release.sent'), outcome.txHash);
      } else {
        // A warning rather than a success: the release worked, but the thing
        // the manager was watching for — the coins leaving — did not happen.
        toast.toast({
          tone: 'warning',
          title: t('release.releasedNotSent'),
          description: say(t, outcome.sendIssue, undefined) || t('release.sendByHand'),
        });
      }
      setRefusing(null);
      setReason('');
      await load();
      router.refresh();
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setBusy(null);
    }
  };

  if (rows === null) {
    return (
      <Card>
        <CardBody className="flex justify-center py-12">
          <Loader2 className="size-5 animate-spin text-content-tertiary" />
        </CardBody>
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardBody className="flex flex-col items-center gap-2 py-12 text-center">
          <Inbox className="size-8 text-content-tertiary" />
          <p className="text-sm text-content-secondary">{t('release.empty')}</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-content-secondary">
          {t('release.waiting', { count: rows.length })}
        </p>
        <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
      </div>

      {/*
        What pressing the button will actually do, said before it is pressed.
        Without this a manager releases a sale, reads "released", and has no
        way of knowing whether the coins moved — which is the question he
        pressed it to settle.
      */}
      {sending &&
        (sending.ready ? (
          <Alert tone="success" title={t('release.autoOn')}>
            {t('release.autoOnBody', {
              address: sending.address ?? '',
              perTransfer: plain(sending.perTransfer),
              perDay: plain(sending.perDay),
              sentToday: plain(sending.sentToday),
            })}
          </Alert>
        ) : (
          <Alert tone="warning" title={t('release.autoOff')}>
            {t('release.autoOffBody')}
          </Alert>
        ))}

      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <Card key={row.id}>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-xs font-medium text-primary-text ltr-content">
                  {row.reference}
                </span>
                <span className="text-xs text-content-tertiary">
                  <DateText value={row.createdAt} relative />
                </span>
                <span className="ms-auto text-xs text-content-tertiary">
                  {t('transactions.staff')}: {ln(row.createdBy, 'fullName')}
                </span>
              </div>

              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="text-2xl font-bold text-content tabular-nums">
                  <Money value={row.toAmount} currency="USDT" />
                </span>
                <span className="text-sm text-content-secondary">
                  {t('release.paidWith')}{' '}
                  <Money value={row.fromAmount} currency={row.fromCurrency} />
                </span>
              </div>

              {/*
                The address, whole and split. This is the thing being decided;
                everything else on the row is context for it.
              */}
              {row.payoutAddress && (
                <div className="rounded-[var(--radius-control)] border border-border-base bg-surface-sunken p-3">
                  <p className="text-xs text-content-tertiary">
                    {t('withdraw.address')}
                    {row.payoutWallet && (
                      <span className="ms-2 font-medium text-content-secondary">
                        {ln(row.payoutWallet, 'label')} · {row.payoutWallet.network}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 break-all font-mono text-sm ltr-content">
                    <span className="font-bold text-content">{row.payoutAddress.slice(0, 6)}</span>
                    <span className="text-content-tertiary">{row.payoutAddress.slice(6, -6)}</span>
                    <span className="font-bold text-content">{row.payoutAddress.slice(-6)}</span>
                  </p>
                </div>
              )}

              {(row.customer || row.counterpartyName) && (
                <p className="text-sm text-content-secondary">
                  {t('transactions.customer')}:{' '}
                  <span className="text-content">
                    {row.customer ? ln(row.customer, 'fullName') : row.counterpartyName}
                  </span>
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  icon={<Check />}
                  loading={busy === row.id}
                  onClick={() => void decide(row, true)}
                >
                  {t('release.release')}
                </Button>
                <Button
                  variant="danger"
                  icon={<X />}
                  disabled={busy === row.id}
                  onClick={() => {
                    setRefusing(row);
                    setReason('');
                  }}
                >
                  {t('release.refuse')}
                </Button>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>

      <Dialog
        open={refusing !== null}
        onClose={() => setRefusing(null)}
        title={t('release.refuseTitle')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRefusing(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy === refusing?.id}
              disabled={reason.trim().length < 3}
              onClick={() => refusing && void decide(refusing, false, reason.trim())}
            >
              {t('release.refuse')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning">{t('release.refuseBody')}</Alert>
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('release.reasonPlaceholder')}
            rows={3}
            required
          />
        </div>
      </Dialog>
    </>
  );
}
