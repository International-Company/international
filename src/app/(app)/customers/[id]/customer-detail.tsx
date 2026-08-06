'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Ban, BadgeCheck, ShieldCheck } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, CardBody, CardHeader, DetailRow, EmptyState } from '@/ui/primitives';
import { ConfirmDialog, useToast } from '@/ui/overlay';
import { Field, Select, Textarea } from '@/ui/form';
import { DateText, Money, RiskBadge, StatusBadge, TransactionTypeBadge } from '@/ui/display';

interface CustomerData {
  id: string;
  code: string;
  type: string;
  fullNameEn: string;
  fullNameAr: string;
  phone: string | null;
  altPhone: string | null;
  email: string | null;
  nationalId: string | null;
  passportNo: string | null;
  address: string | null;
  city: string | null;
  country: string;
  kycStatus: string;
  kycVerifiedAt: string | null;
  riskLevel: string;
  isBlocked: boolean;
  blockReason: string | null;
  notes: string | null;
  createdAt: string;
  balances: { currencyCode: string; balance: string; currency: { nameEn: string; nameAr: string } }[];
  documents: {
    id: string;
    type: string;
    number: string;
    issuedAt: string | null;
    expiresAt: string | null;
  }[];
  transactions: {
    id: string;
    reference: string;
    type: string;
    status: string;
    fromCurrency: string;
    fromAmount: string;
    createdAt: string;
  }[];
  _count: { transactions: number };
}

interface AuditEntry {
  id: number;
  at: string;
  summaryEn: string;
  summaryAr: string;
  actorName: string | null;
}

export function CustomerDetail({
  customer,
  history,
  permissions,
}: {
  customer: CustomerData;
  history: AuditEntry[];
  permissions: string[];
}) {
  const { t, locale, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [dialog, setDialog] = useState<'kyc' | 'block' | null>(null);
  const [kycStatus, setKycStatus] = useState(customer.kycStatus);
  const [riskLevel, setRiskLevel] = useState(customer.riskLevel);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.post(`/api/customers/${customer.id}`, body);
      toast.success(t('common.saved'));
      setDialog(null);
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
      {customer.isBlocked && (
        <Alert tone="danger" icon={<Ban />} title={t('customers.blocked')}>
          {customer.blockReason}
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title={t('common.details')}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={customer.kycStatus} scope="customers" />
                <RiskBadge level={customer.riskLevel} />
                <Badge tone="neutral">{t(`customers.type.${customer.type}` as never)}</Badge>
              </div>
            }
          />
          <CardBody>
            <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
              <dl className="divide-y divide-border-subtle">
                <DetailRow label={t('customers.fullNameAr')}>{customer.fullNameAr}</DetailRow>
                <DetailRow label={t('customers.fullNameEn')}>{customer.fullNameEn}</DetailRow>
                <DetailRow label={t('customers.phone')}>
                  <span className="ltr-content">{customer.phone ?? '—'}</span>
                </DetailRow>
                <DetailRow label={t('customers.email')}>
                  <span className="ltr-content">{customer.email ?? '—'}</span>
                </DetailRow>
              </dl>
              <dl className="divide-y divide-border-subtle">
                <DetailRow label={t('customers.nationalId')}>
                  <span className="ltr-content">{customer.nationalId ?? '—'}</span>
                </DetailRow>
                <DetailRow label={t('customers.passportNo')}>
                  <span className="ltr-content">{customer.passportNo ?? '—'}</span>
                </DetailRow>
                <DetailRow label={t('customers.city')}>{customer.city ?? '—'}</DetailRow>
                <DetailRow label={t('common.createdAt')}>
                  <DateText value={customer.createdAt} />
                </DetailRow>
              </dl>
            </div>

            {customer.notes && (
              <div className="mt-4 rounded-[var(--radius-control)] bg-surface-sunken p-3">
                <p className="text-xs font-medium text-content-secondary">{t('common.notes')}</p>
                <p className="mt-1 text-sm text-content">{customer.notes}</p>
              </div>
            )}
          </CardBody>
        </Card>

        <div className="space-y-4">
          {permissions.includes('customers.balance.view') && (
            <Card>
              <CardHeader title={t('customers.balances')} />
              {customer.balances.length === 0 ? (
                <EmptyState title={t('common.none')} />
              ) : (
                <div className="divide-y divide-border-base">
                  {customer.balances.map((balance) => (
                    <div
                      key={balance.currencyCode}
                      className="flex items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <span className="text-sm text-content">
                        {ln(balance.currency, 'name')}
                      </span>
                      <Money
                        value={balance.balance}
                        currency={balance.currencyCode}
                        colored
                        className="text-sm font-medium"
                      />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          <Card>
            <CardHeader title={t('common.actions')} />
            <CardBody className="space-y-2">
              {permissions.includes('customers.kyc.manage') && (
                <Button
                  variant="secondary"
                  fullWidth
                  icon={<BadgeCheck />}
                  onClick={() => setDialog('kyc')}
                >
                  {t('customers.kycManage')}
                </Button>
              )}
              {permissions.includes('customers.block') && (
                <Button
                  variant={customer.isBlocked ? 'secondary' : 'danger'}
                  fullWidth
                  icon={customer.isBlocked ? <ShieldCheck /> : <Ban />}
                  onClick={() => setDialog('block')}
                >
                  {customer.isBlocked ? t('customers.unblock') : t('customers.block')}
                </Button>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {/* --- Transactions ------------------------------------------------- */}
      <Card>
        <CardHeader
          title={t('customers.transactionHistory')}
          description={t('customers.transactionCount', { count: customer._count.transactions })}
        />
        {customer.transactions.length === 0 ? (
          <EmptyState title={t('transactions.emptyTitle')} />
        ) : (
          <table className="w-full">
            <tbody className="divide-y divide-border-base">
              {customer.transactions.map((transaction) => (
                <tr key={transaction.id} className="hover:bg-surface-hover">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/exchange/transactions/${transaction.id}`}
                      className="font-mono text-xs text-primary-text ltr-content hover:underline"
                    >
                      {transaction.reference}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <TransactionTypeBadge type={transaction.type} />
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    <Money
                      value={transaction.fromAmount}
                      currency={transaction.fromCurrency}
                      className="text-sm font-medium"
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={transaction.status} />
                  </td>
                  <td className="px-4 py-2.5 text-end text-xs text-content-tertiary">
                    <DateText value={transaction.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* --- Audit -------------------------------------------------------- */}
      {history.length > 0 && (
        <Card>
          <CardHeader title={t('audit.title')} />
          <ol className="divide-y divide-border-base">
            {history.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-4 px-4 py-2.5">
                <p className="text-sm text-content">
                  {locale === 'ar' ? entry.summaryAr : entry.summaryEn}
                </p>
                <span className="shrink-0 text-xs text-content-tertiary">
                  <DateText value={entry.at} withTime />
                </span>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* --- Dialogs ------------------------------------------------------- */}
      <ConfirmDialog
        open={dialog === 'kyc'}
        onClose={() => setDialog(null)}
        onConfirm={() => void act({ action: 'kyc', status: kycStatus, riskLevel })}
        title={t('customers.kycManage')}
        confirmLabel={t('common.save')}
        cancelLabel={t('common.cancel')}
        loading={busy}
      >
        <div className="space-y-4">
          <Field label={t('customers.kyc')}>
            {(props) => (
              <Select
                {...props}
                options={['NONE', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'].map((value) => ({
                  value,
                  label: t(`customers.kycStatus.${value}` as never),
                }))}
                value={kycStatus}
                onChange={(event) => setKycStatus(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('customers.riskLevel')}>
            {(props) => (
              <Select
                {...props}
                options={['LOW', 'MEDIUM', 'HIGH'].map((value) => ({
                  value,
                  label: t(`customers.risk.${value}` as never),
                }))}
                value={riskLevel}
                onChange={(event) => setRiskLevel(event.target.value)}
              />
            )}
          </Field>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'block'}
        onClose={() => setDialog(null)}
        onConfirm={() =>
          void act({ action: 'block', blocked: !customer.isBlocked, reason })
        }
        title={customer.isBlocked ? t('customers.unblock') : t('customers.block')}
        confirmLabel={t('common.confirm')}
        cancelLabel={t('common.cancel')}
        tone={customer.isBlocked ? 'primary' : 'danger'}
        loading={busy}
      >
        {!customer.isBlocked && (
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('customers.blockReason')}
            rows={3}
            autoFocus
          />
        )}
      </ConfirmDialog>
    </div>
  );
}
