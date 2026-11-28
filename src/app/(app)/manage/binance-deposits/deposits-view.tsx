'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Search, Wallet as WalletIcon } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { Alert, Badge, Button, Card, EmptyState } from '@/ui/primitives';
import { Input, Select } from '@/ui/form';
import { DateText } from '@/ui/display';

interface Row {
  id: string;
  txHash: string;
  direction: 'IN' | 'OUT';
  fromAddress: string;
  amount: string;
  tokenSymbol: string;
  status: string;
  blockTimestamp: string | null;
  firstSeenAt: string;
  notes: string | null;
  wallet: { id: string; label: string; labelAr: string };
  linkedTransaction: { id: string; reference: string } | null;
  mergedTransactionId: string | null;
}

interface Page {
  rows: Row[];
  total: number;
  page: number;
  pageCount: number;
}

/** The coins a customer most often sends; any other is found by the search. */
const COINS = ['USDT', 'USDC', 'BNB', 'TRX', 'ETH', 'BTC', 'FDUSD'];
const PAGE_SIZE = 50;

/** A scaled amount as it is: 0.5, 300, 12.345678 — never rounded to two places. */
function coinAmount(scaled: string): string {
  const digits = BigInt(scaled).toString().padStart(9, '0');
  const fraction = digits.slice(-8).replace(/0+$/, '');
  const whole = digits.slice(0, -8).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function BinanceDepositsView({
  wallets,
  canSync,
}: {
  wallets: { id: string; label: string; labelAr: string }[];
  canSync: boolean;
}) {
  const { t, ln } = useLocale();
  const [coin, setCoin] = useState('');
  const [direction, setDirection] = useState<'IN' | 'OUT'>('IN');
  const [search, setSearch] = useState('');
  const [typed, setTyped] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [total, setTotal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (at: number) => {
      const query = new URLSearchParams({
        network: 'BINANCE',
        direction,
        page: String(at),
        pageSize: String(PAGE_SIZE),
        ...(coin ? { token: coin } : {}),
        ...(search ? { search } : {}),
      });
      const result = await api.get<Page>(`/api/usdt/transactions?${query}`);
      setRows((current) => (at === 1 ? result.rows : [...(current ?? []), ...result.rows]));
      setPage(result.page);
      setPageCount(result.pageCount);
      setTotal(result.total);
    },
    [coin, direction, search],
  );

  useEffect(() => {
    setRows(null);
    void load(1).catch(() => setRows([]));
  }, [load]);

  // Typed into the search: asked once the typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(typed.trim()), 400);
    return () => clearTimeout(timer);
  }, [typed]);

  // Kept fresh while it is open, quietly.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(1).catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      if (canSync) {
        await Promise.all(
          wallets.map((wallet) => api.post(`/api/usdt/wallets/${wallet.id}`, { action: 'sync' }).catch(() => null)),
        );
      }
      await load(1);
    } finally {
      setRefreshing(false);
    }
  };

  if (wallets.length === 0) {
    return <Alert tone="warning">{t('binanceDeposits.noWallet')}</Alert>;
  }

  const status = (row: Row) =>
    row.status === 'FAILED' ? (
      <Badge tone="danger">{t('binanceDeposits.failed')}</Badge>
    ) : row.status === 'PENDING' ? (
      <Badge tone="warning">{t('binanceDeposits.pending')}</Badge>
    ) : null;

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="min-w-48 flex-1">
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={t('binanceDeposits.search')}
            iconStart={<Search className="size-4" />}
          />
        </div>
        <Select
          value={coin}
          onChange={(event) => setCoin(event.target.value)}
          options={[{ value: '', label: t('binanceDeposits.allCoins') }, ...COINS.map((code) => ({ value: code, label: code }))]}
          className="w-36"
        />
        <Select
          value={direction}
          onChange={(event) => setDirection(event.target.value as 'IN' | 'OUT')}
          options={[
            { value: 'IN', label: t('binanceDeposits.incoming') },
            { value: 'OUT', label: t('binanceDeposits.outgoing') },
          ]}
          className="w-32"
        />
        <Button variant="secondary" icon={<RefreshCw />} loading={refreshing} onClick={() => void refresh()}>
          {t('binanceDeposits.refresh')}
        </Button>
      </Card>

      {rows === null ? (
        <div className="flex justify-center py-10">
          <RefreshCw className="size-5 animate-spin text-content-tertiary" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<WalletIcon />} title={t('binanceDeposits.empty')} />
      ) : (
        <Card className="p-0">
          <p className="border-b border-border-subtle px-4 py-2 text-xs text-content-tertiary">
            {t('binanceDeposits.total', { count: total })}
          </p>
          <ul className="divide-y divide-border-subtle">
            {rows.map((row) => {
              const deal = row.linkedTransaction;
              return (
                <li key={row.id} className="space-y-1 px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-lg font-bold tabular-nums text-content ltr-content">
                      {coinAmount(row.amount)} {row.tokenSymbol}
                    </span>
                    {row.tokenSymbol !== 'USDT' && <Badge tone="primary">{row.tokenSymbol}</Badge>}
                    {status(row)}
                    <span className="text-xs text-content-tertiary">
                      <DateText value={row.blockTimestamp ?? row.firstSeenAt} withTime />
                    </span>
                    {wallets.length > 1 && (
                      <span className="text-xs text-content-tertiary">{ln(row.wallet, 'label')}</span>
                    )}
                    <span className="ms-auto text-xs">
                      {deal ? (
                        <Link href={`/manage/transactions/${deal.id}`} className="font-medium text-primary-text hover:underline">
                          {t('binanceDeposits.settled')} {deal.reference}
                        </Link>
                      ) : row.mergedTransactionId ? (
                        <Link
                          href={`/manage/transactions/${row.mergedTransactionId}`}
                          className="font-medium text-primary-text hover:underline"
                        >
                          {t('binanceDeposits.settled')}
                        </Link>
                      ) : (
                        row.direction === 'IN' && <span className="text-content-tertiary">{t('binanceDeposits.waiting')}</span>
                      )}
                    </span>
                  </div>
                  {row.notes && <p className="text-xs text-content-secondary ltr-content">{row.notes}</p>}
                  {row.direction === 'IN' && row.fromAddress && (
                    <p className="text-xs text-content-tertiary">
                      {t('binanceDeposits.from')} <span className="font-mono ltr-content">{row.fromAddress}</span>
                    </p>
                  )}
                  <p className="break-all font-mono text-[11px] text-content-tertiary ltr-content">{row.txHash}</p>
                </li>
              );
            })}
          </ul>
          {page < pageCount && (
            <div className="border-t border-border-subtle p-3 text-center">
              <Button variant="ghost" onClick={() => void load(page + 1)}>
                {t('binanceDeposits.more')}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
