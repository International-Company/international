'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Calculator,
  Check,
  Pencil,
  Printer,
  Undo2,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { formatRate } from '@/i18n/format';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardHeader, DetailRow } from '@/ui/primitives';
import { ShareButton } from '@/ui/share';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Input, MoneyInput, Textarea } from '@/ui/form';
import { DateText, Money, Rate, StatusBadge } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * One transaction, and what it did to the drawers.
 *
 * The movements are the whole explanation now. There is no journal to expand
 * into and no accounts to trace through: money came out of one drawer and went
 * into another, and the balance each was left at is on the row. When a customer
 * disputes a receipt, that is the answer, and it is already on the screen.
 */

interface Movement {
  id: string;
  direction: string;
  amount: string;
  balanceAfter: string;
  reason: string;
  createdAt: string;
  drawer: { currencyCode: string; nameEn: string; nameAr: string };
}

interface TransactionData {
  id: string;
  reference: string;
  type: string;
  status: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  rate: string;
  profitAmount: string;
  notes: string | null;
  createdAt: string;
  createdById: string;
  counterpartyName: string | null;
  counterpartyPhone: string | null;
  intakeBankChannel: string | null;
  payoutBankChannel: string | null;
  payoutAddress: string | null;
  payoutWallet: { id: string; label: string; labelAr: string; network: string } | null;
  reverseReason: string | null;
  customer: { id: string; code: string; fullNameEn: string; fullNameAr: string } | null;
  createdBy: { fullNameEn: string; fullNameAr: string; username: string };
  branch: { nameEn: string; nameAr: string };
  receipts: { id: string; number: string; printedCount: number }[];
  reversalOf: { id: string; reference: string } | null;
  reversedBy: { id: string; reference: string } | null;
  chainTransaction: { id: string; txHash: string; network: string } | null;
  depositRequest: { id: string; reference: string } | null;
  movements: Movement[];
}

interface AuditEntry {
  id: number;
  at: string;
  action: string;
  summaryEn: string;
  summaryAr: string;
  actorName: string | null;
}

export function TransactionDetail({
  transaction,
  history,
  permissions,
}: {
  transaction: TransactionData;
  history: AuditEntry[];
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const canReverse =
    (transaction.status === 'POSTED' || transaction.status === 'PENDING_TRANSFER') &&
    !transaction.reversalOf &&
    permissions.includes('exchange.transaction.reverse');

  /*
   * Editing covers only what never moved money. Correcting an amount is a
   * different act — it reverses and reposts — so it sits behind the same
   * permission but is offered as its own button, with its own dialog, rather
   * than hidden inside a form that looks like it is just changing a field.
   */
  const canEdit =
    !transaction.reversalOf && permissions.includes('exchange.transaction.edit');

  /*
   * A remittance is not corrected this way, so the button is not offered.
   *
   * Correction re-runs the original conversion at the original rate: give one
   * figure and the other follows. A remittance has no conversion — what the
   * customer settled and what the correspondent charged are two independent
   * numbers — so it is reversed and recorded again instead. The service refuses
   * it either way; this is so nobody is invited to try.
   */
  const canCorrect =
    canEdit &&
    canReverse &&
    transaction.type !== 'REMITTANCE_OUT' &&
    transaction.type !== 'REMITTANCE_IN';

  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState({ counterpartyName: '', counterpartyPhone: '', notes: '' });

  const openEditor = () => {
    setDetails({
      counterpartyName: transaction.counterpartyName ?? '',
      counterpartyPhone: transaction.counterpartyPhone ?? '',
      notes: transaction.notes ?? '',
    });
    setEditing(true);
  };

  const saveDetails = async () => {
    setBusy(true);
    try {
      await api.post(`/api/manage/transactions/${transaction.id}`, {
        action: 'edit',
        counterpartyName: details.counterpartyName.trim() || null,
        counterpartyPhone: details.counterpartyPhone.trim() || null,
        notes: details.notes.trim() || null,
      });
      toast.success(t('common.saved'), transaction.reference);
      setEditing(false);
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const [correcting, setCorrecting] = useState(false);
  const [correctAmount, setCorrectAmount] = useState('');
  const [correctReason, setCorrectReason] = useState('');

  const correct = async () => {
    setBusy(true);
    try {
      const result = await api.post<{ reference: string }>(
        `/api/manage/transactions/${transaction.id}`,
        { action: 'correct', fromAmount: correctAmount.trim(), reason: correctReason.trim() },
      );
      toast.success(t('transactions.corrected'), result.reference);
      setCorrecting(false);
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const canConfirmTransfer =
    transaction.status === 'PENDING_TRANSFER' &&
    permissions.includes('exchange.transfer.confirm');

  const confirmTransfer = async () => {
    setBusy(true);
    try {
      await api.post(`/api/manage/transactions/${transaction.id}`, { action: 'confirmTransfer' });
      toast.success(t('transactions.transferConfirmed'), transaction.reference);
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  const reverse = async () => {
    setBusy(true);
    try {
      await api.post(`/api/manage/transactions/${transaction.id}`, {
        action: 'reverse',
        reason,
      });
      toast.success(t('common.saved'), transaction.reference);
      setReversing(false);
      setReason('');
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {transaction.status === 'PENDING_TRANSFER' && (
        <Alert tone="warning" icon={<AlertTriangle />} title={t('machine.pendingTransfer')}>
          <p>{t('transactions.pendingTransfersHint')}</p>
          {canConfirmTransfer && (
            <Button
              className="mt-2"
              size="sm"
              variant="primary"
              icon={<Check />}
              loading={busy}
              onClick={() => void confirmTransfer()}
            >
              {t('transactions.confirmTransfer')}
            </Button>
          )}
        </Alert>
      )}

      {transaction.reversedBy && (
        <Alert tone="warning" icon={<AlertTriangle />} title={t('transactions.reverse')}>
          {t('transactions.reversedBy', { reference: transaction.reversedBy.reference })}{' '}
          <Link href={`/manage/transactions/${transaction.reversedBy.id}`} className="underline">
            {t('common.view')}
          </Link>
        </Alert>
      )}
      {transaction.reversalOf && (
        <Alert tone="neutral">
          {t('transactions.reversalOf', { reference: transaction.reversalOf.reference })}
          {transaction.reverseReason ? ` — ${transaction.reverseReason}` : ''}
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title={t('common.details')}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={transaction.status} />
                <Badge tone="neutral">
                  {t(`transactions.type.${transaction.type}` as never)}
                </Badge>
              </div>
            }
          />
          <CardBody>
            {/* What the customer gave and took, which is the whole trade. */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-[var(--radius-control)] bg-surface-sunken p-3">
                <p className="text-xs text-content-secondary">{t('machine.customerPays')}</p>
                <p className="mt-1 font-mono text-xl font-semibold text-content ltr-content">
                  <Money value={transaction.fromAmount} currency={transaction.fromCurrency} />
                </p>
              </div>
              <div className="rounded-[var(--radius-control)] bg-surface-sunken p-3">
                <p className="text-xs text-content-secondary">{t('machine.customerReceives')}</p>
                <p className="mt-1 font-mono text-xl font-semibold text-content ltr-content">
                  <Money value={transaction.toAmount} currency={transaction.toCurrency} />
                </p>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              <DetailRow label={t('machine.rateApplied')}>
                <Rate value={transaction.rate} />
              </DetailRow>
              {/* Only when there was a transfer — otherwise it is a blank row
                  answering a question nobody asked. */}
              {transaction.payoutBankChannel && (
                <DetailRow label={t('transactions.transferredTo')}>
                  {transaction.payoutBankChannel}
                </DetailRow>
              )}
              {transaction.intakeBankChannel && (
                <DetailRow label={t('withdraw.paidInto')}>
                  {transaction.intakeBankChannel}
                </DetailRow>
              )}
              {/* Where the coins went, and from which wallet. The address is
                  shown whole: a shortened one cannot be checked against
                  anything, and checking it is the only reason to print it. */}
              {transaction.payoutAddress && (
                <DetailRow label={t('withdraw.address')}>
                  <span className="break-all font-mono text-xs ltr-content">
                    {transaction.payoutAddress}
                  </span>
                </DetailRow>
              )}
              {transaction.payoutWallet && (
                <DetailRow label={t('withdraw.sendFrom')}>
                  {ln(transaction.payoutWallet, 'label')} — {transaction.payoutWallet.network}
                </DetailRow>
              )}
              {permissions.includes('exchange.margin.view') && (
                <DetailRow label={t('transactions.profit')}>
                  <Money value={transaction.profitAmount} currency={transaction.toCurrency} />
                </DetailRow>
              )}
              <DetailRow label={t('common.createdAt')}>
                <DateText value={transaction.createdAt} withTime />
              </DetailRow>
              <DetailRow label={t('transactions.createdBy')}>
                {ln(transaction.createdBy, 'fullName')}
              </DetailRow>
              {transaction.customer && (
                <DetailRow label={t('transactions.customer')}>
                  {ln(transaction.customer, 'fullName')}
                </DetailRow>
              )}
              {transaction.counterpartyName && (
                <DetailRow label={t('transactions.counterpartyName')}>
                  {transaction.counterpartyName}
                </DetailRow>
              )}
              {transaction.counterpartyPhone && (
                <DetailRow label={t('transactions.counterpartyPhone')}>
                  <a
                    href={`tel:${transaction.counterpartyPhone}`}
                    dir="ltr"
                    className="font-mono underline ltr-content"
                  >
                    {transaction.counterpartyPhone}
                  </a>
                </DetailRow>
              )}
            </dl>

            {transaction.notes && (
              <div className="mt-4 rounded-[var(--radius-control)] bg-surface-sunken p-3">
                <p className="text-xs font-medium text-content-secondary">{t('common.notes')}</p>
                <p className="mt-1 text-sm text-content">{transaction.notes}</p>
              </div>
            )}

            {transaction.chainTransaction && (
              <div className="mt-4 rounded-[var(--radius-control)] border border-border-base p-3">
                <p className="text-xs text-content-secondary">
                  {t('counter.matchedTitle')} · {transaction.chainTransaction.network}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-content ltr-content">
                  {transaction.chainTransaction.txHash}
                </p>
              </div>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title={t('common.actions')} />
            <CardBody className="space-y-2">
              {permissions.includes('exchange.receipt.print') && (
                <>
                  <Button
                    variant="secondary"
                    fullWidth
                    icon={<Printer />}
                    onClick={() => window.open(`/print/receipt/${transaction.id}`, '_blank')}
                  >
                    {t('transactions.printReceipt')}
                  </Button>
                  {/*
                    Beside the reprint, because they answer the same question —
                    somebody wants this transaction in their hand, and half the
                    time they are not in the building.
                  */}
                  <ShareButton transactionId={transaction.id} variant="secondary" size="md" />
                </>
              )}
              {canEdit && (
                <Button variant="secondary" fullWidth icon={<Pencil />} onClick={openEditor}>
                  {t('transactions.editDetails')}
                </Button>
              )}
              {canCorrect && (
                <Button
                  variant="secondary"
                  fullWidth
                  icon={<Calculator />}
                  onClick={() => {
                    setCorrectAmount(plainAmount(transaction.fromAmount));
                    setCorrectReason('');
                    setCorrecting(true);
                  }}
                >
                  {t('transactions.correct')}
                </Button>
              )}
              {canReverse && (
                <Button
                  variant="danger"
                  fullWidth
                  icon={<Undo2 />}
                  onClick={() => setReversing(true)}
                >
                  {t('transactions.reverse')}
                </Button>
              )}
              {!canReverse && !canEdit && !permissions.includes('exchange.receipt.print') && (
                <p className="text-sm text-content-secondary">{t('common.none')}</p>
              )}
            </CardBody>
          </Card>

          {/* --- What it did to the drawers ------------------------------ */}
          <Card>
            <CardHeader title={t('drawers.movements')} />
            <ul className="divide-y divide-border-base">
              {transaction.movements.map((movement) => {
                const incoming = movement.direction === 'IN';
                return (
                  <li key={movement.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 text-sm text-content">
                        {incoming ? (
                          <ArrowDownLeft className="h-4 w-4 text-success-text" />
                        ) : (
                          <ArrowUpRight className="h-4 w-4 text-danger-text" />
                        )}
                        {ln(movement.drawer, 'name')}
                      </span>
                      <span
                        className={cn(
                          'font-mono text-sm ltr-content',
                          incoming ? 'text-success-text' : 'text-danger-text',
                        )}
                      >
                        {incoming ? '+' : '−'}
                        <Money value={movement.amount} />
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-content-tertiary ltr-content">
                      {t('drawers.balanceAfter')} <Money value={movement.balanceAfter} />{' '}
                      {movement.drawer.currencyCode}
                    </p>
                  </li>
                );
              })}
              {transaction.movements.length === 0 && (
                <li className="px-4 py-6 text-sm text-content-secondary">{t('common.noResults')}</li>
              )}
            </ul>
          </Card>
        </div>
      </div>

      {/* --- Audit trail ---------------------------------------------------- */}
      {history.length > 0 && (
        <Card>
          <CardHeader title={t('audit.title')} />
          <ol className="divide-y divide-border-base">
            {history.map((entry) => (
              <li key={entry.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-content">{ln(entry, 'summary')}</span>
                  <span className="text-xs text-content-tertiary">
                    <DateText value={entry.at} withTime />
                  </span>
                </div>
                {entry.actorName && (
                  <p className="mt-0.5 text-xs text-content-secondary">{entry.actorName}</p>
                )}
              </li>
            ))}
          </ol>
        </Card>
      )}

      <ConfirmDialog
        open={reversing}
        onClose={() => setReversing(false)}
        onConfirm={() => void reverse()}
        title={t('transactions.reverseTitle')}
        message={t('transactions.reverseWarning')}
        confirmLabel={t('transactions.reverse')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={busy}
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('transactions.reverseReason')}
          rows={3}
          required
        />
      </ConfirmDialog>

      {/* --- The parts that never moved money ---------------------------- */}
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title={t('transactions.editDetails')}
        description={t('transactions.editDetailsHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void saveDetails()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label={t('transactions.counterpartyName')}>
            {(props) => (
              <Input
                {...props}
                value={details.counterpartyName}
                onChange={(event) =>
                  setDetails({ ...details, counterpartyName: event.target.value })
                }
              />
            )}
          </Field>

          <Field label={t('transactions.counterpartyPhone')}>
            {(props) => (
              <Input
                {...props}
                dir="ltr"
                value={details.counterpartyPhone}
                onChange={(event) =>
                  setDetails({ ...details, counterpartyPhone: event.target.value })
                }
              />
            )}
          </Field>

          <Field label={t('common.notes')}>
            {(props) => (
              <Textarea
                {...props}
                rows={3}
                value={details.notes}
                onChange={(event) => setDetails({ ...details, notes: event.target.value })}
              />
            )}
          </Field>
        </div>
      </Dialog>

      {/* --- Correcting an amount: reverse and repost, together ----------- */}
      <Dialog
        open={correcting}
        onClose={() => setCorrecting(false)}
        title={t('transactions.correct')}
        description={t('transactions.correctHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCorrecting(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={correctReason.trim().length < 3 || !correctAmount.trim()}
              onClick={() => void correct()}
            >
              {t('transactions.correct')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Alert tone="neutral">
            {t('transactions.correctKeepsRate', {
              rate: `1 ${transaction.fromCurrency} = ${formatRate(transaction.rate)} ${transaction.toCurrency}`,
            })}
          </Alert>

          <Field label={t('machine.customerPays')} required>
            {(props) => (
              <MoneyInput
                {...props}
                value={correctAmount}
                onValueChange={setCorrectAmount}
                currency={transaction.fromCurrency}
              />
            )}
          </Field>

          <Field label={t('common.reason')} required>
            {(props) => (
              <Textarea
                {...props}
                rows={2}
                value={correctReason}
                onChange={(event) => setCorrectReason(event.target.value)}
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

/** A 1e8-scaled amount as something a money field can hold. */
function plainAmount(scaled: string): string {
  const value = BigInt(scaled || '0');
  const digits = value.toString().padStart(9, '0');
  const fraction = digits.slice(-8).replace(/0+$/, '');
  return fraction ? `${digits.slice(0, -8)}.${fraction}` : digits.slice(0, -8);
}
