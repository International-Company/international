'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Camera,
  Check,
  Pencil,
  Printer,
  Undo2,
  UserRoundCheck,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Alert, Badge, Button, Card, CardBody, CardHeader, DetailRow } from '@/ui/primitives';
import { ShareButton } from '@/ui/share';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select, Textarea } from '@/ui/form';
import { DateText, Money, Rate, StatusBadge } from '@/ui/display';
import { cn } from '@/ui/utils';
import { shrinkPhoto } from '@/ui/proof-photo';

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
  transferConfirmedAt: string | null;
  counterpartyName: string | null;
  counterpartyPhone: string | null;
  intakeBankChannel: string | null;
  intakeCashAmount: string;
  intakeBrokerAmount: string;
  payoutBankChannel: string | null;
  payoutAccount: string | null;
  payoutAddress: string | null;
  deliveredAmount: string | null;
  deliveredUnit: string | null;
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
  proofs,
  tellers,
  permissions,
}: {
  transaction: TransactionData;
  history: AuditEntry[];
  /** Photos of what the customer paid. */
  proofs: { id: string; kind: string; createdAt: string }[];
  /** Who a deal can be moved to; empty for anyone who cannot move one. */
  tellers: { id: string; fullNameAr: string; fullNameEn: string }[];
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
   * Handing a deal to the teller it belonged to. Offered on what the machine
   * records and not on a transfer already sent; the rest — an earlier day, say —
   * the server refuses in words, rather than the button silently not being here.
   */
  const [moving, setMoving] = useState(false);
  const [tellerId, setTellerId] = useState('');
  const others = tellers.filter((teller) => teller.id !== transaction.createdById);
  const canMove =
    canReverse &&
    ['EXCHANGE', 'WALLET_CASHOUT', 'WALLET_TOPUP'].includes(transaction.type) &&
    !transaction.transferConfirmedAt &&
    others.length > 0;

  const [addingProof, setAddingProof] = useState(false);
  const isSale = transaction.type === 'USDT_SALE';
  const canAddProof =
    (transaction.type === 'REMITTANCE_OUT' || isSale) &&
    transaction.status !== 'REVERSED' &&
    !transaction.reversalOf &&
    permissions.includes(isSale ? 'usdt.withdrawal.use' : 'exchange.remittance.use') &&
    proofs.length < 5;

  const addProof = async (file: File | undefined, kind: 'PAYMENT' | 'BENEFICIARY' | 'ADDRESS') => {
    if (!file) return;
    setAddingProof(true);
    try {
      const image = await shrinkPhoto(file).catch(() => null);
      if (!image) {
        toast.error(t('errors.title'), t('errors.proofImageInvalid'));
        return;
      }
      await api.post(`/api/manage/transactions/${transaction.id}/proofs`, { image, kind });
      toast.success(t('common.saved'));
      router.refresh();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setAddingProof(false);
    }
  };

  const move = async () => {
    setBusy(true);
    try {
      const moved = await api.post<{ id: string; reference: string }>(
        `/api/manage/transactions/${transaction.id}`,
        { action: 'moveToTeller', tellerId },
      );
      toast.success(t('transactions.moved'), moved.reference);
      setMoving(false);
      router.push(`/manage/transactions/${moved.id}`);
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

  /*
   * Editing covers only what never moved money. There is no way to change an
   * amount here: a wrong figure is reversed and the trade recorded again, so a
   * drawer only ever moves by a whole transaction somebody can point to.
   */
  const canEdit = !transaction.reversalOf && permissions.includes('exchange.transaction.edit');

  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState({
    counterpartyName: '',
    counterpartyPhone: '',
    notes: '',
  });

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

  const canConfirmTransfer =
    transaction.status === 'PENDING_TRANSFER' && permissions.includes('exchange.transfer.confirm');

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
                <Badge tone="neutral">{t(`transactions.type.${transaction.type}` as never)}</Badge>
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
              {transaction.payoutAccount && (
                <DetailRow label={t('receive.account')}>
                  <span className="font-mono ltr-content">{transaction.payoutAccount}</span>
                </DetailRow>
              )}
              {transaction.intakeBankChannel && (
                <DetailRow label={t('withdraw.paidInto')}>
                  {transaction.intakeBankChannel}
                </DetailRow>
              )}
              {/* Paid both ways: how much came each way. */}
              {BigInt(transaction.intakeBrokerAmount) > 0n &&
                BigInt(transaction.intakeCashAmount) > 0n && (
                  <>
                    <DetailRow label={t('receipt.paidByTransfer')}>
                      <Money
                        value={transaction.intakeBrokerAmount}
                        currency={transaction.fromCurrency}
                      />
                    </DetailRow>
                    <DetailRow label={t('receipt.paidInCash')}>
                      <Money
                        value={transaction.intakeCashAmount}
                        currency={transaction.fromCurrency}
                      />
                    </DetailRow>
                  </>
                )}
              {transaction.deliveredAmount && (
                <DetailRow label={t('remittance.delivered')}>
                  <Money value={transaction.deliveredAmount} currency={transaction.deliveredUnit ?? ''} />
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
              {canMove && (
                <Button
                  variant="secondary"
                  fullWidth
                  icon={<UserRoundCheck />}
                  onClick={() => {
                    setTellerId(others[0]?.id ?? '');
                    setMoving(true);
                  }}
                >
                  {t('transactions.moveToTeller')}
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

          {/* --- The photos a remittance carries ------------------------- */}
          {(proofs.length > 0 || canAddProof) &&
            (isSale
              ? ([
                  ['PAYMENT', t('usdtSale.transferPhoto'), t('usdtSale.transferPhotoAttach')],
                  ['ADDRESS', t('usdtSale.addressPhoto'), t('usdtSale.addressPhotoAttach')],
                ] as const)
              : ([
                  ['PAYMENT', t('remittance.proof'), t('remittance.proofAttach')],
                  ['BENEFICIARY', t('remittance.beneficiaryDetails'), t('remittance.beneficiaryAttach')],
                ] as const)
            ).map(([kind, title, attach]) => {
              const own = proofs.filter((proof) => proof.kind === kind);
              if (own.length === 0 && !canAddProof) return null;
              return (
                <Card key={kind}>
                  <CardHeader title={title} />
                  <CardBody className="space-y-3">
                    {own.length > 0 && (
                      <div className="grid grid-cols-3 gap-2">
                        {own.map((proof) => (
                          <a
                            key={proof.id}
                            href={`/api/manage/transactions/${transaction.id}/proofs/${proof.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/manage/transactions/${transaction.id}/proofs/${proof.id}`}
                              alt={title}
                              className="aspect-square w-full rounded-lg object-cover ring-1 ring-border-subtle"
                            />
                          </a>
                        ))}
                      </div>
                    )}
                    {canAddProof && (
                      <label className="flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-control)] border border-border-base px-2 text-center text-sm text-content-secondary transition-colors hover:border-primary hover:text-primary-text">
                        <Camera className="size-4 shrink-0" />
                        {addingProof ? t('common.loading') : attach}
                        <input
                          type="file"
                          accept="image/*"
                          className="sr-only"
                          disabled={addingProof}
                          onChange={(event) => {
                            void addProof(event.target.files?.[0], kind);
                            event.target.value = '';
                          }}
                        />
                      </label>
                    )}
                  </CardBody>
                </Card>
              );
            })}

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
                <li className="px-4 py-6 text-sm text-content-secondary">
                  {t('common.noResults')}
                </li>
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

      {/* --- A deal recorded on the wrong account ------------------------ */}
      <ConfirmDialog
        open={moving}
        onClose={() => setMoving(false)}
        onConfirm={() => void move()}
        title={t('transactions.moveToTeller')}
        message={t('transactions.moveHint', { reference: transaction.reference })}
        confirmLabel={t('transactions.moveConfirm')}
        cancelLabel={t('common.cancel')}
        loading={busy}
      >
        <Field label={t('transactions.moveTeller')} required>
          {(props) => (
            <Select
              {...props}
              options={others.map((teller) => ({
                value: teller.id,
                label: ln(teller, 'fullName'),
              }))}
              value={tellerId}
              onChange={(event) => setTellerId(event.target.value)}
            />
          )}
        </Field>
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
    </div>
  );
}
