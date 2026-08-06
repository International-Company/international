'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Ban, Check, Printer, Undo2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, DetailRow } from '@/ui/primitives';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Textarea } from '@/ui/form';
import { DateText, Money, Rate, StatusBadge, TransactionTypeBadge } from '@/ui/display';

/**
 * Transaction detail and workflow actions.
 *
 * The journal entries are shown in full, not summarised. When a customer
 * disputes a receipt or an auditor asks how a figure arose, the answer is the
 * actual double-entry posting — and it should be one click away, not a support
 * request.
 */

interface JournalLine {
  id: string;
  debit: string;
  credit: string;
  balanceAfter: string;
  currencyCode: string;
  memo: string | null;
  account: { code: string; nameEn: string; nameAr: string; type: string };
}

interface TransactionData {
  id: string;
  reference: string;
  type: string;
  status: string;
  channel: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  rate: string;
  feeCurrency: string | null;
  feeAmount: string;
  profitAmount: string;
  notes: string | null;
  internalNotes: string | null;
  cancelReason: string | null;
  createdAt: string;
  valueDate: string;
  postedAt: string | null;
  createdById: string;
  customer: { id: string; code: string; fullNameEn: string; fullNameAr: string } | null;
  createdBy: { fullNameEn: string; fullNameAr: string; username: string };
  branch: { nameEn: string; nameAr: string };
  counterpartyName: string | null;
  counterpartyPhone: string | null;
  receipts: { id: string; number: string; printedCount: number }[];
  reversalOf: { id: string; reference: string } | null;
  reversedBy: { id: string; reference: string } | null;
  chainTransaction: { id: string; txHash: string; network: string } | null;
  journalEntries: {
    id: string;
    reference: string;
    description: string;
    descriptionAr: string | null;
    postedAt: string;
    isReversal: boolean;
    lines: JournalLine[];
  }[];
}

interface AuditEntry {
  id: number;
  at: string;
  action: string;
  summaryEn: string;
  summaryAr: string;
  actorName: string | null;
}

type PendingAction = 'submit' | 'reverse' | 'cancel' | null;

export function TransactionDetail({
  transaction,
  history,
  permissions,
  currentUserId,
}: {
  transaction: TransactionData;
  history: AuditEntry[];
  permissions: string[];
  currentUserId: string;
}) {
  const { t, locale, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [pending, setPending] = useState<PendingAction>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const can = (permission: string) => permissions.includes(permission);
  const isOwn = transaction.createdById === currentUserId;

  // A draft is the only unposted state left, so submitting it is the one action
  // that moves money. Everything else either undoes or abandons the record.
  const canSubmit = transaction.status === 'DRAFT' && can('exchange.transaction.create');
  const canReverse = transaction.status === 'POSTED' && can('exchange.transaction.reverse');
  const canCancel = transaction.status === 'DRAFT' && can('exchange.transaction.delete');

  const act = async (action: Exclude<PendingAction, null>) => {
    setBusy(true);
    try {
      await api.post(`/api/exchange/transactions/${transaction.id}/actions`, {
        action,
        ...(action === 'reverse' || action === 'cancel' ? { reason } : {}),
      });

      toast.success(t('common.saved'), transaction.reference);
      setPending(null);
      setReason('');
      router.refresh();
    } catch (error) {
      toast.error(
        t('errors.title'),
        error instanceof ApiError
          ? t(error.messageKey as never, error.params) || error.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* --- Banners ------------------------------------------------------ */}
      {transaction.reversedBy && (
        <Alert tone="warning" icon={<AlertTriangle />} title={t('transactions.reverse')}>
          {t('transactions.reversedBy', { reference: transaction.reversedBy.reference })}{' '}
          <Link
            href={`/exchange/transactions/${transaction.reversedBy.id}`}
            className="underline"
          >
            {t('common.view')}
          </Link>
        </Alert>
      )}
      {transaction.reversalOf && (
        <Alert tone="neutral">
          {t('transactions.reversalOf', { reference: transaction.reversalOf.reference })}
        </Alert>
      )}
      {transaction.cancelReason && (
        <Alert tone="danger" title={t('transactions.cancelReason')}>
          {transaction.cancelReason}
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* --- Summary --------------------------------------------------- */}
        <Card className="lg:col-span-2">
          <CardHeader
            title={t('common.details')}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={transaction.status} />
                <TransactionTypeBadge type={transaction.type} />
              </div>
            }
          />
          <CardBody>
            <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              <dl className="divide-y divide-border-subtle">
                <DetailRow label={t('transactions.fromAmount')}>
                  <Money
                    value={transaction.fromAmount}
                    currency={transaction.fromCurrency}
                    className="font-semibold"
                  />
                </DetailRow>
                {transaction.toCurrency !== transaction.fromCurrency && (
                  <>
                    <DetailRow label={t('transactions.toAmount')}>
                      <Money
                        value={transaction.toAmount}
                        currency={transaction.toCurrency}
                        className="font-semibold"
                      />
                    </DetailRow>
                    <DetailRow label={t('transactions.appliedRate')}>
                      <span className="ltr-content">
                        1 {transaction.fromCurrency} = <Rate value={transaction.rate} />{' '}
                        {transaction.toCurrency}
                      </span>
                    </DetailRow>
                  </>
                )}
                {transaction.feeAmount !== '0' && (
                  <DetailRow label={t('transactions.fee')}>
                    <Money
                      value={transaction.feeAmount}
                      currency={transaction.feeCurrency ?? transaction.fromCurrency}
                    />
                  </DetailRow>
                )}
                {can('dashboard.financials.view') && (
                  <DetailRow label={t('transactions.profit')}>
                    <Money value={transaction.profitAmount} currency={transaction.toCurrency} colored />
                  </DetailRow>
                )}
              </dl>

              <dl className="divide-y divide-border-subtle">
                <DetailRow label={t('transactions.customer')}>
                  {transaction.customer ? (
                    <Link
                      href={`/customers/${transaction.customer.id}`}
                      className="text-primary-text hover:underline"
                    >
                      {ln(transaction.customer, 'fullName')}
                    </Link>
                  ) : (
                    transaction.counterpartyName || '—'
                  )}
                </DetailRow>
                <DetailRow label={t('transactions.createdBy')}>
                  {ln(transaction.createdBy, 'fullName')}
                </DetailRow>
                <DetailRow label={t('common.branch')}>{ln(transaction.branch, 'name')}</DetailRow>
                <DetailRow label={t('transactions.valueDate')}>
                  <DateText value={transaction.valueDate} />
                </DetailRow>
                <DetailRow label={t('common.createdAt')}>
                  <DateText value={transaction.createdAt} withTime />
                </DetailRow>
                {transaction.postedAt && (
                  <DetailRow label={t('transactions.postedAt')}>
                    <DateText value={transaction.postedAt} withTime />
                  </DetailRow>
                )}
                <DetailRow label={t('transactions.channel')}>
                  <Badge tone="neutral">
                    {t(`transactions.channelType.${transaction.channel}` as never)}
                  </Badge>
                </DetailRow>
              </dl>
            </div>

            {transaction.notes && (
              <div className="mt-4 rounded-[var(--radius-control)] bg-surface-sunken p-3">
                <p className="text-xs font-medium text-content-secondary">{t('common.notes')}</p>
                <p className="mt-1 text-sm text-content">{transaction.notes}</p>
              </div>
            )}

            {transaction.chainTransaction && (
              <div className="mt-4">
                <Link
                  href={`/usdt/transactions/${transaction.chainTransaction.id}`}
                  className="text-sm text-primary-text hover:underline"
                >
                  {t('usdt.linkedTransaction')} · {transaction.chainTransaction.network} ·{' '}
                  <span className="font-mono text-xs ltr-content">
                    {transaction.chainTransaction.txHash.slice(0, 18)}…
                  </span>
                </Link>
              </div>
            )}
          </CardBody>
        </Card>

        {/* --- Actions ----------------------------------------------------- */}
        <div className="space-y-4">
          <Card>
            <CardHeader title={t('common.actions')} />
            <CardBody className="space-y-2">
              {canSubmit && (
                <Button
                  variant="primary"
                  fullWidth
                  icon={<Check />}
                  onClick={() => setPending('submit')}
                >
                  {t('transactions.submit')}
                </Button>
              )}
              {transaction.status === 'POSTED' && can('exchange.receipt.print') && (
                <Button
                  variant="secondary"
                  fullWidth
                  icon={<Printer />}
                  onClick={() => window.open(`/print/receipt/${transaction.id}`, '_blank')}
                >
                  {t('transactions.printReceipt')}
                </Button>
              )}
              {canReverse && (
                <Button
                  variant="danger"
                  fullWidth
                  icon={<Undo2 />}
                  onClick={() => setPending('reverse')}
                >
                  {t('transactions.reverse')}
                </Button>
              )}
              {canCancel && (
                <Button variant="ghost" fullWidth icon={<Ban />} onClick={() => setPending('cancel')}>
                  {t('common.cancel')}
                </Button>
              )}
              {!canSubmit && !canReverse && !canCancel &&
                transaction.status !== 'POSTED' && (
                  <p className="text-sm text-content-secondary">{t('common.none')}</p>
                )}
            </CardBody>
          </Card>

        </div>
      </div>

      {/* --- Journal ------------------------------------------------------- */}
      {transaction.journalEntries.length > 0 && (
        <Card>
          <CardHeader title={t('transactions.journalEntries')} />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-base bg-surface-sunken">
                  <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                    {t('accounts.accountName')}
                  </th>
                  <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                    {t('accounts.debit')}
                  </th>
                  <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                    {t('accounts.credit')}
                  </th>
                  <th className="hidden px-4 py-2 text-end text-xs font-medium text-content-secondary sm:table-cell">
                    {t('accounts.balanceAfter')}
                  </th>
                </tr>
              </thead>
              {transaction.journalEntries.map((entry) => (
                <tbody key={entry.id} className="divide-y divide-border-base">
                  <tr className="bg-surface-sunken/50">
                    <td colSpan={4} className="px-4 py-1.5">
                      <span className="font-mono text-xs text-content-secondary ltr-content">
                        {entry.reference}
                      </span>
                      <span className="ms-2 text-xs text-content-tertiary">
                        {locale === 'ar' && entry.descriptionAr
                          ? entry.descriptionAr
                          : entry.description}
                      </span>
                      {entry.isReversal && (
                        <Badge tone="warning" className="ms-2">
                          {t('transactions.reverse')}
                        </Badge>
                      )}
                    </td>
                  </tr>
                  {entry.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-4 py-2">
                        <span className="text-sm text-content">{ln(line.account, 'name')}</span>
                        <span className="ms-2 font-mono text-[10px] text-content-tertiary ltr-content">
                          {line.account.code}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-end">
                        {line.debit !== '0' && (
                          <Money value={line.debit} currency={line.currencyCode} />
                        )}
                      </td>
                      <td className="px-4 py-2 text-end">
                        {line.credit !== '0' && (
                          <Money value={line.credit} currency={line.currencyCode} />
                        )}
                      </td>
                      <td className="hidden px-4 py-2 text-end text-content-secondary sm:table-cell">
                        <Money value={line.balanceAfter} currency={line.currencyCode} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </Card>
      )}

      {/* --- Audit trail ---------------------------------------------------- */}
      {history.length > 0 && (
        <Card>
          <CardHeader title={t('audit.title')} />
          <ol className="divide-y divide-border-base">
            {history.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-4 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-content">
                    {locale === 'ar' ? entry.summaryAr : entry.summaryEn}
                  </p>
                  <p className="mt-0.5 text-xs text-content-tertiary">
                    {entry.actorName ?? t('common.unknown')}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-content-tertiary">
                  <DateText value={entry.at} withTime />
                </span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* --- Confirmation dialogs -------------------------------------------- */}
      <ConfirmDialog
        open={pending === 'submit'}
        onClose={() => setPending(null)}
        onConfirm={() => void act('submit')}
        title={t('transactions.submitTitle')}
        message={t('transactions.submitConfirm', { reference: transaction.reference })}
        confirmLabel={t('transactions.submit')}
        cancelLabel={t('common.cancel')}
        loading={busy}
      />

      <ConfirmDialog
        open={pending === 'reverse'}
        onClose={() => setPending(null)}
        onConfirm={() => void act('reverse')}
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

      <ConfirmDialog
        open={pending === 'cancel'}
        onClose={() => setPending(null)}
        onConfirm={() => void act('cancel')}
        title={t('transactions.cancelTitle')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.close')}
        tone="danger"
        loading={busy}
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('transactions.cancelReason')}
          rows={2}
          required
        />
      </ConfirmDialog>
    </div>
  );
}
