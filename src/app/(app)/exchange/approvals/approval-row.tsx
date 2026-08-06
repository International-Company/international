'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Button } from '@/ui/primitives';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Textarea } from '@/ui/form';
import { DateText, Money, TransactionTypeBadge } from '@/ui/display';

interface PendingTransaction {
  id: string;
  reference: string;
  type: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  createdAt: string;
  notes: string | null;
  customer: { code: string; fullNameEn: string; fullNameAr: string } | null;
  createdBy: { fullNameEn: string; fullNameAr: string };
  branch: { nameEn: string; nameAr: string };
}

/**
 * A single row in the approval queue.
 *
 * Approve and reject are available inline — an approver working through a
 * queue of twenty should not have to open and return from each one.
 */
export function ApprovalRow({ transaction }: { transaction: PendingTransaction }) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (action: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await api.post(`/api/exchange/transactions/${transaction.id}/actions`, {
        action,
        ...(action === 'reject' ? { reason } : {}),
      });
      toast.success(t('common.saved'), transaction.reference);
      setRejecting(false);
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
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/exchange/transactions/${transaction.id}`}
            className="font-mono text-sm font-medium text-primary-text ltr-content hover:underline"
          >
            {transaction.reference}
          </Link>
          <TransactionTypeBadge type={transaction.type} />
        </div>

        <p className="mt-1 text-sm text-content">
          {transaction.customer
            ? ln(transaction.customer, 'fullName')
            : ln(transaction.createdBy, 'fullName')}
          <span className="text-content-tertiary">
            {' · '}
            {ln(transaction.branch, 'name')}
            {' · '}
            <DateText value={transaction.createdAt} relative />
          </span>
        </p>

        {transaction.notes && (
          <p className="mt-1 truncate text-xs text-content-secondary">{transaction.notes}</p>
        )}
      </div>

      <div className="flex items-center gap-3 sm:gap-4">
        <Money
          value={transaction.fromAmount}
          currency={transaction.fromCurrency}
          className="text-sm font-semibold"
        />

        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={<Check />}
            loading={busy}
            onClick={() => void act('approve')}
          >
            {t('common.approve')}
          </Button>
          <Button variant="secondary" size="sm" icon={<X />} onClick={() => setRejecting(true)}>
            {t('common.reject')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        onConfirm={() => void act('reject')}
        title={t('transactions.rejectTitle')}
        confirmLabel={t('common.reject')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={busy}
      >
        <Textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('transactions.rejectReason')}
          rows={3}
          autoFocus
        />
      </ConfirmDialog>
    </li>
  );
}
