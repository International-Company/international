'use client';

import Link from 'next/link';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Activity, ArrowUpRight } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { formatDate } from '@/i18n/format';
import { Card, CardHeader, EmptyState } from '@/ui/primitives';
import { DateText, Money, Rate, TransactionTypeBadge, StatusBadge } from '@/ui/display';

/**
 * Dashboard widgets.
 *
 * One chart, deliberately. The trend is genuinely a shape-over-time question, so
 * it earns a plot; everything else — balances, rates, recent activity — is a
 * lookup, and a table answers a lookup faster than any graphic. That restraint
 * is what makes this read as banking software rather than an analytics demo.
 */

interface DashboardData {
  today: { count: number; volume: { currency: string; volume: string; profit: string; count: number }[]; profit: string };
  recentTransactions: {
    id: string;
    reference: string;
    type: string;
    status: string;
    fromCurrency: string;
    fromAmount: string;
    toCurrency: string;
    toAmount: string;
    createdAt: string;
    customer: { fullNameEn: string; fullNameAr: string } | null;
    createdBy: { fullNameEn: string; fullNameAr: string };
  }[];
  accounts: {
    id: string;
    code: string;
    nameEn: string;
    nameAr: string;
    kind: string;
    currencyCode: string;
    balance: string;
  }[];
  rates: {
    id: string;
    baseCode: string;
    quoteCode: string;
    buyRate: string;
    sellRate: string;
    spread: string;
    effectiveFrom: string;
  }[];
  activity: {
    id: number;
    at: string;
    action: string;
    module: string;
    summaryEn: string;
    summaryAr: string;
    actorName: string | null;
  }[];
  trend: { date: string; count: number; volume: string }[];
  canSeeFinancials: boolean;
}

export function DashboardWidgets({ data }: { data: DashboardData }) {
  const { t, locale, ln } = useLocale();

  const trendData = data.trend.map((point) => ({
    date: point.date,
    label: formatDate(point.date, locale, { month: 'short', day: 'numeric' }),
    count: point.count,
    // Recharts needs a number; the exact bigint is only needed for display.
    volume: Number(BigInt(point.volume) / 1_000_000n) / 100,
  }));

  const hasTrend = trendData.some((point) => point.count > 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {/* ------------------------------------------------------------- */}
        {/* Volume trend — the one genuine chart on this page             */}
        {/* ------------------------------------------------------------- */}
        <Card className="xl:col-span-2">
          <CardHeader title={t('dashboard.volumeTrend')} />
          <div className="p-4">
            {hasTrend ? (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="volumeFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.18} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.01} />
                    </linearGradient>
                  </defs>

                  {/* Recessive grid: horizontal only, so it guides the eye
                      without competing with the data. */}
                  <CartesianGrid
                    stroke="var(--chart-grid)"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }}
                    axisLine={{ stroke: 'var(--border)' }}
                    tickLine={false}
                    // In RTL the time axis still runs oldest → newest to the
                    // right; reversing it would misread as a decline.
                    reversed={false}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: 'var(--text-tertiary)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                    orientation={locale === 'ar' ? 'right' : 'left'}
                  />
                  <Tooltip
                    cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
                    contentStyle={{
                      backgroundColor: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      fontSize: 12,
                      color: 'var(--text)',
                      boxShadow: 'var(--shadow-md)',
                    }}
                    labelStyle={{ color: 'var(--text-secondary)', marginBottom: 2 }}
                    formatter={(value: number) => [
                      value.toLocaleString('en-US', { maximumFractionDigits: 2 }),
                      t('reports.volume'),
                    ]}
                  />
                  <Area
                    type="monotone"
                    dataKey="volume"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    fill="url(#volumeFill)"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState
                icon={<Activity />}
                title={t('reports.noData')}
                description={t('transactions.emptyBody')}
              />
            )}
          </div>
        </Card>

        {/* ------------------------------------------------------------- */}
        {/* Rate board                                                     */}
        {/* ------------------------------------------------------------- */}
        <Card>
          <CardHeader
            title={t('dashboard.rateBoard')}
            actions={
              <Link
                href="/exchange/rates"
                className="text-xs text-primary-text hover:underline"
              >
                {t('dashboard.viewAll')}
              </Link>
            }
          />
          {data.rates.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-content-secondary">
              {t('rates.noRates')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border-base">
                    <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                      {t('rates.pair')}
                    </th>
                    <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                      {t('rates.buyRate')}
                    </th>
                    <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                      {t('rates.sellRate')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-base">
                  {data.rates.slice(0, 6).map((rate) => (
                    <tr key={rate.id}>
                      <td className="px-4 py-2 text-sm font-medium text-content ltr-content">
                        {rate.baseCode}/{rate.quoteCode}
                      </td>
                      <td className="px-4 py-2 text-end text-sm text-content">
                        <Rate value={rate.buyRate} />
                      </td>
                      <td className="px-4 py-2 text-end text-sm text-content">
                        <Rate value={rate.sellRate} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {/* ------------------------------------------------------------- */}
        {/* Recent transactions                                            */}
        {/* ------------------------------------------------------------- */}
        <Card className="xl:col-span-2">
          <CardHeader
            title={t('dashboard.recentTransactions')}
            actions={
              <Link
                href="/exchange/transactions"
                className="flex items-center gap-1 text-xs text-primary-text hover:underline"
              >
                {t('dashboard.viewAll')}
                <ArrowUpRight className="size-3" />
              </Link>
            }
          />
          {data.recentTransactions.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-content-secondary">
              {t('transactions.emptyBody')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <tbody className="divide-y divide-border-base">
                    {data.recentTransactions.map((transaction) => (
                      <tr key={transaction.id} className="hover:bg-surface-hover">
                        <td className="px-4 py-2.5">
                          <Link
                            href={`/exchange/transactions/${transaction.id}`}
                            className="font-mono text-xs text-primary-text ltr-content hover:underline"
                          >
                            {transaction.reference}
                          </Link>
                          <p className="mt-0.5 text-xs text-content-tertiary">
                            {transaction.customer
                              ? ln(transaction.customer, 'fullName')
                              : ln(transaction.createdBy, 'fullName')}
                          </p>
                        </td>
                        <td className="px-4 py-2.5 hidden sm:table-cell">
                          <TransactionTypeBadge type={transaction.type} />
                        </td>
                        <td className="px-4 py-2.5 text-end">
                          <Money
                            value={transaction.fromAmount}
                            currency={transaction.fromCurrency}
                            className="text-sm font-medium"
                          />
                        </td>
                        <td className="px-4 py-2.5 hidden sm:table-cell">
                          <StatusBadge status={transaction.status} />
                        </td>
                        <td className="px-4 py-2.5 text-end text-xs text-content-tertiary">
                          <DateText value={transaction.createdAt} relative />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Card>

        {/* ------------------------------------------------------------- */}
        {/* Cash positions                                                 */}
        {/* ------------------------------------------------------------- */}
        {data.canSeeFinancials && (
          <Card>
            <CardHeader
              title={t('dashboard.cashPositions')}
              actions={
                <Link
                  href="/exchange/cashboxes"
                  className="text-xs text-primary-text hover:underline"
                >
                  {t('dashboard.viewAll')}
                </Link>
              }
            />
            <div className="divide-y divide-border-base">
              {data.accounts.slice(0, 8).map((account) => (
                <div key={account.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-content">{ln(account, 'name')}</p>
                    <p className="font-mono text-[10px] text-content-tertiary ltr-content">
                      {account.code}
                    </p>
                  </div>
                  <Money
                    value={account.balance}
                    currency={account.currencyCode}
                    decimals={account.kind === 'CRYPTO' ? 2 : 2}
                    className="shrink-0 text-sm font-medium"
                  />
                </div>
              ))}
              {data.accounts.length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-content-secondary">
                  {t('common.noResults')}
                </p>
              )}
            </div>
          </Card>
        )}
      </div>

      {/* --------------------------------------------------------------- */}
      {/* Activity timeline                                                */}
      {/* --------------------------------------------------------------- */}
      {data.activity.length > 0 && (
        <Card>
          <CardHeader title={t('dashboard.activityTimeline')} />
          <ol className="divide-y divide-border-base">
            {data.activity.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 px-4 py-2.5">
                <span
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-border-strong"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-content">
                    {locale === 'ar' ? entry.summaryAr : entry.summaryEn}
                  </p>
                  <p className="mt-0.5 text-xs text-content-tertiary">
                    {entry.actorName ?? t('common.unknown')} ·{' '}
                    <DateText value={entry.at} relative />
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}
