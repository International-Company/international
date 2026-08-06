'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Search, Users } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Alert, Badge, Button, Card, PageHeader } from '@/ui/primitives';
import { Field, FormGrid, Input, Select } from '@/ui/form';
import { Dialog, useToast } from '@/ui/overlay';
import { DataTable, type Column } from '@/ui/data-table';
import { DateText, Money, RiskBadge, StatusBadge } from '@/ui/display';
import { debounce } from '@/ui/utils';

interface CustomerRow {
  id: string;
  code: string;
  type: string;
  fullNameEn: string;
  fullNameAr: string;
  phone: string | null;
  kycStatus: string;
  riskLevel: string;
  isBlocked: boolean;
  createdAt: string;
  balances: { currencyCode: string; balance: string }[];
  _count: { transactions: number };
}

interface ListResponse {
  rows: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function CustomersView({
  permissions,
  openCreateInitially,
}: {
  permissions: string[];
  openCreateInitially: boolean;
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [kycStatus, setKycStatus] = useState('');
  const [creating, setCreating] = useState(openCreateInitially);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [form, setForm] = useState({
    type: 'INDIVIDUAL',
    fullNameEn: '',
    fullNameAr: '',
    phone: '',
    email: '',
    nationalId: '',
    passportNo: '',
    city: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<ListResponse>(
        `/api/customers${queryString({ page, pageSize: 25, search, kycStatus })}`,
      );
      setData(result);
    } catch {
      toast.error(t('errors.title'), t('errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [page, search, kycStatus, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSearchChange = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
        setPage(1);
      }, 300),
    [],
  );

  const create = async () => {
    setError(null);
    setFieldErrors({});
    setBusy(true);

    try {
      const created = await api.post<{ id: string; code: string }>('/api/customers', {
        ...form,
        email: form.email || null,
        phone: form.phone || null,
        nationalId: form.nationalId || null,
        passportNo: form.passportNo || null,
        city: form.city || null,
      });

      toast.success(t('common.saved'), created.code);
      setCreating(false);
      setForm({ ...form, fullNameEn: '', fullNameAr: '', phone: '', email: '', nationalId: '', passportNo: '' });
      router.push(`/customers/${created.id}`);
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setError(t(caught.messageKey as never, caught.params) || caught.message);
      } else {
        setError(t('errors.generic'));
      }
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<CustomerRow>[] = [
    {
      key: 'code',
      header: t('customers.code'),
      cell: (row) => (
        <span className="font-mono text-xs font-medium text-primary-text ltr-content">{row.code}</span>
      ),
    },
    {
      key: 'name',
      header: t('common.name'),
      cell: (row) => (
        <div>
          <p className="text-sm text-content">{ln(row, 'fullName')}</p>
          {row.phone && (
            <p className="font-mono text-[10px] text-content-tertiary ltr-content">{row.phone}</p>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: t('customers.customerType'),
      cell: (row) => <Badge tone="neutral">{t(`customers.type.${row.type}` as never)}</Badge>,
      hideOnMobile: true,
    },
    {
      key: 'kyc',
      header: t('customers.kyc'),
      cell: (row) => <StatusBadge status={row.kycStatus} scope="customers" />,
      hideOnMobile: true,
    },
    {
      key: 'risk',
      header: t('customers.riskLevel'),
      cell: (row) =>
        row.isBlocked ? (
          <Badge tone="danger">{t('customers.blocked')}</Badge>
        ) : (
          <RiskBadge level={row.riskLevel} />
        ),
      hideOnMobile: true,
    },
    {
      key: 'balances',
      header: t('customers.balances'),
      align: 'end',
      numeric: true,
      cell: (row) =>
        row.balances.length === 0 ? (
          <span className="text-xs text-content-tertiary">—</span>
        ) : (
          <div className="space-y-0.5">
            {row.balances.slice(0, 2).map((balance) => (
              <div key={balance.currencyCode}>
                <Money
                  value={balance.balance}
                  currency={balance.currencyCode}
                  colored
                  className="text-xs"
                />
              </div>
            ))}
          </div>
        ),
      hideOnMobile: true,
    },
    {
      key: 'transactions',
      header: t('nav.transactions'),
      align: 'end',
      numeric: true,
      cell: (row) => <span className="text-sm">{row._count.transactions}</span>,
      hideOnMobile: true,
    },
    {
      key: 'createdAt',
      header: t('common.createdAt'),
      align: 'end',
      cell: (row) => (
        <span className="text-xs text-content-secondary">
          <DateText value={row.createdAt} />
        </span>
      ),
      hideOnMobile: true,
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('customers.title')}
        description={t('customers.subtitle')}
        actions={
          permissions.includes('customers.create') && (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              {t('customers.new')}
            </Button>
          )
        }
      />

      <Card>
        <div className="flex flex-col gap-3 border-b border-border-base p-3 sm:flex-row">
          <Input
            placeholder={t('customers.searchHint')}
            iconStart={<Search />}
            defaultValue={search}
            onChange={(event) => onSearchChange(event.target.value)}
            className="sm:max-w-sm"
          />
          <Select
            options={[
              { value: '', label: t('common.allStatuses') },
              ...['NONE', 'PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'].map((value) => ({
                value,
                label: t(`customers.kycStatus.${value}` as never),
              })),
            ]}
            value={kycStatus}
            onChange={(event) => {
              setKycStatus(event.target.value);
              setPage(1);
            }}
            className="sm:max-w-[12rem]"
          />
        </div>

        <DataTable
          columns={columns}
          rows={data?.rows ?? []}
          rowKey={(row) => row.id}
          loading={loading}
          onRowClick={(row) => router.push(`/customers/${row.id}`)}
          emptyTitle={t('customers.noCustomers')}
          emptyAction={
            permissions.includes('customers.create') && (
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                {t('customers.new')}
              </Button>
            )
          }
          pagination={{
            page: data?.page ?? 1,
            pageSize: data?.pageSize ?? 25,
            total: data?.total ?? 0,
            pageCount: data?.pageCount ?? 1,
            onPageChange: setPage,
          }}
        />
      </Card>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title={t('customers.new')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!form.fullNameEn || !form.fullNameAr}
              onClick={() => void create()}
            >
              {t('common.create')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}

          <Field label={t('customers.customerType')} required>
            {(props) => (
              <Select
                {...props}
                options={[
                  { value: 'INDIVIDUAL', label: t('customers.type.INDIVIDUAL') },
                  { value: 'COMPANY', label: t('customers.type.COMPANY') },
                ]}
                value={form.type}
                onChange={(event) => setForm({ ...form, type: event.target.value })}
              />
            )}
          </Field>

          <FormGrid columns={2}>
            <Field label={t('customers.fullNameAr')} required error={fieldErrors.fullNameAr}>
              {(props) => (
                <Input
                  {...props}
                  value={form.fullNameAr}
                  onChange={(event) => setForm({ ...form, fullNameAr: event.target.value })}
                  dir="rtl"
                />
              )}
            </Field>
            <Field label={t('customers.fullNameEn')} required error={fieldErrors.fullNameEn}>
              {(props) => (
                <Input
                  {...props}
                  value={form.fullNameEn}
                  onChange={(event) => setForm({ ...form, fullNameEn: event.target.value })}
                  dir="ltr"
                />
              )}
            </Field>
          </FormGrid>

          <FormGrid columns={2}>
            <Field label={t('customers.phone')} error={fieldErrors.phone}>
              {(props) => (
                <Input
                  {...props}
                  value={form.phone}
                  onChange={(event) => setForm({ ...form, phone: event.target.value })}
                  dir="ltr"
                />
              )}
            </Field>
            <Field label={t('customers.email')} error={fieldErrors.email}>
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                  dir="ltr"
                />
              )}
            </Field>
          </FormGrid>

          <FormGrid columns={2}>
            <Field label={t('customers.nationalId')} error={fieldErrors.nationalId}>
              {(props) => (
                <Input
                  {...props}
                  value={form.nationalId}
                  onChange={(event) => setForm({ ...form, nationalId: event.target.value })}
                  dir="ltr"
                />
              )}
            </Field>
            <Field label={t('customers.passportNo')} error={fieldErrors.passportNo}>
              {(props) => (
                <Input
                  {...props}
                  value={form.passportNo}
                  onChange={(event) => setForm({ ...form, passportNo: event.target.value })}
                  dir="ltr"
                />
              )}
            </Field>
          </FormGrid>

          <Field label={t('customers.city')}>
            {(props) => (
              <Input
                {...props}
                value={form.city}
                onChange={(event) => setForm({ ...form, city: event.target.value })}
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
