'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowDownLeft, ArrowUpRight, Link2, ShieldCheck } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Badge, Button, Card } from '@/ui/primitives';
import { Select } from '@/ui/form';
import { DataTable, type Column } from '@/ui/data-table';
import { CopyableId, DateText, Money, StatusBadge } from '@/ui/display';
import { useToast } from '@/ui/overlay';

interface ChainRow {
  id: string;
  txHash: string;
  network: string;
  direction: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  tokenSymbol: string;
  blockNumber: string | null;
  blockTimestamp: string | null;
  confirmations: number;
  status: string;
  isReconciled: boolean;
  wallet: { id: string; label: string; labelAr: string; network: string; address: string };
  linkedTransaction: { id: string; reference: string; status: string } | null;
}

interface ListResponse {
  rows: ChainRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

const EXPLORERS: Record<string, (hash: string) => string> = {
  TRON: (hash) => `https://tronscan.org/#/transaction/${hash}`,
  ETHEREUM: (hash) => `https://etherscan.io/tx/${hash}`,
  BSC: (hash) => `https://bscscan.com/tx/${hash}`,
};

export function ChainTransactionsView({
  initial,
  wallets,
  initialWalletId,
  permissions,
}: {
  initial: ListResponse;
  wallets: { id: string; label: string; labelAr: string; network: string }[];
  initialWalletId: string;
  permissions: string[];
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [data, setData] = useState<ListResponse>(initial);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [walletId, setWalletId] = useState(initialWalletId);
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<ListResponse>(
        `/api/usdt/transactions${queryString({ page, pageSize: 25, walletId, direction, status })}`,
      );
      setData(result);
    } catch {
      toast.error(t('errors.title'), t('errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [page, walletId, direction, status, t, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: 'link' | 'reconcile') => {
    setActing(id);
    try {
      const result = await api.post<{ transactionId?: string }>(`/api/usdt/transactions/${id}`, {
        action,
      });

      toast.success(t('common.saved'));
      if (action === 'link' && result.transactionId) {
        router.push(`/exchange/transactions/${result.transactionId}`);
      } else {
        void load();
      }
    } catch (error) {
      toast.error(
        t('errors.title'),
        error instanceof ApiError
          ? t(error.messageKey as never, error.params) || error.message
          : t('errors.generic'),
      );
    } finally {
      setActing(null);
    }
  };

  const columns: Column<ChainRow>[] = [
    {
      key: 'direction',
      header: t('usdt.direction'),
      cell: (row) => (
        <span className="inline-flex items-center gap-1.5">
          {row.direction === 'IN' ? (
            <ArrowDownLeft className="size-4 text-success-text" />
          ) : (
            <ArrowUpRight className="size-4 text-danger-text" />
          )}
          <span className="text-xs">
            {row.direction === 'IN' ? t('usdt.incoming') : t('usdt.outgoing')}
          </span>
        </span>
      ),
    },
    {
      key: 'wallet',
      header: t('usdt.wallet'),
      cell: (row) => (
        <div>
          <p className="text-sm text-content">{ln(row.wallet, 'label')}</p>
          <p className="text-[10px] text-content-tertiary">{row.network}</p>
        </div>
      ),
      hideOnMobile: true,
    },
    {
      key: 'amount',
      header: t('common.amount'),
      align: 'end',
      numeric: true,
      cell: (row) => (
        <Money value={row.amount} currency={row.tokenSymbol} decimals={6} className="font-medium" />
      ),
    },
    {
      key: 'counterparty',
      header: t('usdt.sender'),
      cell: (row) => (
        <CopyableId
          value={row.direction === 'IN' ? row.fromAddress : row.toAddress}
          display={`${(row.direction === 'IN' ? row.fromAddress : row.toAddress).slice(0, 10)}…`}
        />
      ),
      hideOnMobile: true,
    },
    {
      key: 'status',
      header: t('common.status'),
      cell: (row) => (
        <div className="flex flex-col gap-1">
          <StatusBadge status={row.status} scope="usdt" />
          {row.isReconciled && <Badge tone="success">{t('usdt.reconciled')}</Badge>}
        </div>
      ),
    },
    {
      key: 'linked',
      header: t('usdt.linkedTransaction'),
      cell: (row) =>
        row.linkedTransaction ? (
          <Link
            href={`/exchange/transactions/${row.linkedTransaction.id}`}
            className="font-mono text-xs text-primary-text ltr-content hover:underline"
          >
            {row.linkedTransaction.reference}
          </Link>
        ) : (
          <span className="text-xs text-content-tertiary">—</span>
        ),
      hideOnMobile: true,
    },
    {
      key: 'time',
      header: t('common.date'),
      align: 'end',
      cell: (row) => (
        <span className="text-xs text-content-secondary">
          <DateText value={row.blockTimestamp} relative />
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: 'actions',
      header: '',
      align: 'end',
      cell: (row) => (
        <div className="flex justify-end gap-1">
          <a
            href={EXPLORERS[row.network]?.(row.txHash) ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            title={t('usdt.viewOnExplorer')}
            className="rounded p-1.5 text-content-tertiary hover:bg-surface-hover hover:text-content"
          >
            <Link2 className="size-4" />
          </a>

          {!row.linkedTransaction &&
            row.status === 'CONFIRMED' &&
            permissions.includes('usdt.transaction.link') && (
              <Button
                size="sm"
                variant="ghost"
                loading={acting === row.id}
                onClick={(event) => {
                  event.stopPropagation();
                  void act(row.id, 'link');
                }}
              >
                {t('usdt.createTransaction')}
              </Button>
            )}

          {!row.isReconciled && permissions.includes('usdt.transaction.reconcile') && (
            <Button
              size="sm"
              variant="ghost"
              icon={<ShieldCheck />}
              loading={acting === row.id}
              onClick={(event) => {
                event.stopPropagation();
                void act(row.id, 'reconcile');
              }}
            >
              <span className="hidden sm:inline">{t('usdt.reconcile')}</span>
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border-base p-3 sm:flex-row">
        <Select
          options={[
            { value: '', label: t('common.allWallets') },
            ...wallets.map((wallet) => ({ value: wallet.id, label: ln(wallet, 'label') })),
          ]}
          value={walletId}
          onChange={(event) => {
            setWalletId(event.target.value);
            setPage(1);
          }}
          className="sm:max-w-xs"
        />
        <Select
          options={[
            { value: '', label: t('common.allDirections') },
            { value: 'IN', label: t('usdt.incoming') },
            { value: 'OUT', label: t('usdt.outgoing') },
          ]}
          value={direction}
          onChange={(event) => {
            setDirection(event.target.value);
            setPage(1);
          }}
          className="sm:max-w-[10rem]"
        />
        <Select
          options={[
            { value: '', label: t('common.allStatuses') },
            { value: 'PENDING', label: t('usdt.status.PENDING') },
            { value: 'CONFIRMED', label: t('usdt.status.CONFIRMED') },
            { value: 'FAILED', label: t('usdt.status.FAILED') },
          ]}
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
          className="sm:max-w-[10rem]"
        />
      </div>

      <DataTable
        columns={columns}
        rows={data.rows}
        rowKey={(row) => row.id}
        loading={loading}
        emptyTitle={t('usdt.noTransactions')}
        pagination={{
          page: data.page,
          pageSize: data.pageSize,
          total: data.total,
          pageCount: data.pageCount,
          onPageChange: setPage,
        }}
      />
    </Card>
  );
}
