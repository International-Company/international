'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Plus, RefreshCw, Search } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Button, Card, PageHeader } from '@/ui/primitives';
import { Input, Select } from '@/ui/form';
import { DataTable, type Column, type SortState } from '@/ui/data-table';
import { DateText, Money, StatusBadge, TransactionTypeBadge } from '@/ui/display';
import { useToast } from '@/ui/overlay';
import { TRANSACTION_STATUSES, TRANSACTION_TYPES } from '@/modules/exchange/transaction-types';
import { debounce } from '@/ui/utils';

interface TransactionRow {
  id: string;
  reference: string;
  type: string;
  status: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  createdAt: string;
  valueDate: string;
  customer: { id: string; code: string; fullNameEn: string; fullNameAr: string } | null;
  createdBy: { id: string; fullNameEn: string; fullNameAr: string };
}

interface ListResponse {
  rows: TransactionRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function TransactionsView({
  permissions,
  initialSearch = '',
}: {
  permissions: string[];
  initialSearch?: string;
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState<SortState>({ field: 'createdAt', order: 'desc' });
  const [search, setSearch] = useState(initialSearch);
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<ListResponse>(
        `/api/manage/transactions${queryString({
          page,
          pageSize,
          sort: sort.field,
          order: sort.order,
          search,
          status,
          type,
        })}`,
      );
      setData(result);
    } catch (error) {
      toast.error(
        t('errors.title'),
        error instanceof ApiError ? error.message : t('errors.generic'),
      );
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, sort, search, status, type, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Debounced so typing a reference does not issue a request per keystroke.
  const onSearchChange = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
        setPage(1);
      }, 300),
    [],
  );

  const columns: Column<TransactionRow>[] = [
    {
      key: 'reference',
      header: t('transactions.reference'),
      sortKey: 'reference',
      cell: (row) => (
        <span className="font-mono text-xs font-medium text-primary-text ltr-content">
          {row.reference}
        </span>
      ),
    },
    {
      key: 'type',
      header: t('common.type'),
      sortKey: 'type',
      cell: (row) => <TransactionTypeBadge type={row.type} />,
      hideOnMobile: true,
    },
    {
      /*
       * Who recorded it.
       *
       * This column was headed "customer" and fell back to the staff member
       * whenever no customer was attached — which at a counter is most of the
       * time. So it read as the customer's name and was usually the teller's,
       * which is the kind of small lie a manager only catches once it has cost
       * him an argument.
       *
       * It is the staff member now, always, and says so. A customer, when one
       * is attached, is on the transaction's own page and on the receipt.
       */
      key: 'staff',
      header: t('transactions.staff'),
      cell: (row) => <span className="text-sm">{ln(row.createdBy, 'fullName')}</span>,
      hideOnMobile: true,
    },
    {
      key: 'amount',
      header: t('common.amount'),
      align: 'end',
      numeric: true,
      sortKey: 'fromAmount',
      cell: (row) => (
        <div>
          <Money value={row.fromAmount} currency={row.fromCurrency} className="font-medium" />
          {row.toCurrency !== row.fromCurrency && (
            <div className="text-xs text-content-tertiary">
              → <Money value={row.toAmount} currency={row.toCurrency} />
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: t('common.status'),
      sortKey: 'status',
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'createdAt',
      header: t('common.createdAt'),
      align: 'end',
      sortKey: 'createdAt',
      cell: (row) => (
        <span className="text-xs text-content-secondary">
          <DateText value={row.createdAt} withTime />
        </span>
      ),
      hideOnMobile: true,
    },
  ];

  const statusOptions = [
    { value: '', label: t('common.allStatuses') },
    ...TRANSACTION_STATUSES.map((value) => ({
      value,
      label: t(`transactions.status.${value}` as never),
    })),
  ];

  const typeOptions = [
    { value: '', label: t('common.allTypes') },
    ...TRANSACTION_TYPES.map((value) => ({
      value,
      label: t(`transactions.type.${value}` as never),
    })),
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('transactions.title')}
        description={t('transactions.subtitle')}
        actions={
          <>
            <Button variant="secondary" icon={<RefreshCw />} onClick={() => void load()}>
              {t('common.refresh')}
            </Button>
          </>
        }
      />

      <Card>
        <div className="flex flex-col gap-3 border-b border-border-base p-3 sm:flex-row sm:items-center">
          <Input
            placeholder={t('common.searchPlaceholder')}
            iconStart={<Search />}
            defaultValue={search}
            onChange={(event) => onSearchChange(event.target.value)}
            className="sm:max-w-xs"
          />
          <Select
            options={statusOptions}
            value={status}
            aria-label={t('common.status')}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            className="sm:max-w-[12rem]"
          />
          <Select
            options={typeOptions}
            value={type}
            aria-label={t('common.type')}
            onChange={(event) => {
              setType(event.target.value);
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
          sort={sort}
          onSortChange={(next) => {
            setSort(next);
            setPage(1);
          }}
          onRowClick={(row) => router.push(`/manage/transactions/${row.id}`)}
          emptyTitle={t('transactions.emptyTitle')}
          emptyDescription={t('transactions.emptyBody')}
          pagination={{
            page: data?.page ?? 1,
            pageSize: data?.pageSize ?? pageSize,
            total: data?.total ?? 0,
            pageCount: data?.pageCount ?? 1,
            onPageChange: setPage,
            onPageSizeChange: (size) => {
              setPageSize(size);
              setPage(1);
            },
          }}
        />
      </Card>

      {permissions.includes('reports.export') && (
        <p className="text-end">
          <a
            href="/api/reports/transactionSummary?format=xlsx"
            className="inline-flex items-center gap-1.5 text-xs text-primary-text hover:underline"
          >
            <Download className="size-3.5" />
            {t('common.exportExcel')}
          </a>
        </p>
      )}
    </div>
  );
}
