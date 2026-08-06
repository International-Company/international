import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Activity,
  ArrowLeftRight,
  BadgeCheck,
  Banknote,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { requirePermission } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { loadDashboard } from '@/modules/dashboard/dashboard.service';
import { toJsonSafe } from '@/core/http/json';
import { Card, CardHeader, PageHeader, StatTile } from '@/ui/primitives';
import { DashboardWidgets } from './widgets';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await requirePermission('dashboard.view');
  const { t, locale } = await getTranslator();

  const data = await loadDashboard({
    userId: session.user.id,
    permissions: session.user.permissions,
    branchId: session.user.branchId,
  });

  const displayName = locale === 'ar' ? session.user.fullNameAr : session.user.fullNameEn;

  // The reporting currency drives the headline tile; fall back to the largest
  // day's currency when nothing has traded in it yet.
  const headline =
    data.today.volume.find((entry) => entry.currency === 'ILS') ?? data.today.volume[0];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.welcome', { name: displayName })}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label={t('dashboard.todayTransactions')}
          value={data.today.count}
          icon={<ArrowLeftRight />}
          hint={t('common.today')}
          href="/exchange/transactions"
        />

        {data.canSeeFinancials && (
          <StatTile
            label={t('dashboard.todayVolume')}
            value={
              headline
                ? `${(Number(headline.volume) / 1e8).toLocaleString('en-US', {
                    maximumFractionDigits: 0,
                  })} ${headline.currency}`
                : '—'
            }
            icon={<Banknote />}
            hint={
              data.today.volume.length > 1
                ? `+${data.today.volume.length - 1} ${t('common.currency')}`
                : undefined
            }
          />
        )}

        <StatTile
          label={t('dashboard.pendingApprovals')}
          value={data.pendingCount}
          icon={<BadgeCheck />}
          tone={data.pendingCount > 0 ? 'warning' : 'neutral'}
          href="/exchange/approvals"
        />

        {data.usdtPortfolio && (
          <StatTile
            label={t('dashboard.usdtBalance')}
            value={
              data.usdtPortfolio.byToken[0]
                ? `${(Number(data.usdtPortfolio.byToken[0].total) / 1e8).toLocaleString('en-US', {
                    maximumFractionDigits: 2,
                  })} ${data.usdtPortfolio.byToken[0].token}`
                : '0'
            }
            icon={<Wallet />}
            hint={`${data.usdtPortfolio.walletCount} ${t('usdt.wallets')}`}
            href="/usdt/wallets"
          />
        )}

        {!data.usdtPortfolio && data.canSeeFinancials && (
          <StatTile
            label={t('dashboard.todayProfit')}
            value={`${(Number(data.today.profit) / 1e8).toFixed(2)}`}
            icon={<TrendingUp />}
            hint={t('transactions.profit')}
          />
        )}
      </div>

      {/* Everything below needs client-side formatting and charting. */}
      <DashboardWidgets data={toJsonSafe(data)} />

      {data.activity.length === 0 && (
        <Card>
          <CardHeader title={t('dashboard.activityTimeline')} />
          <p className="px-4 py-8 text-center text-sm text-content-secondary">
            {t('dashboard.noActivity')}
          </p>
        </Card>
      )}

      <p className="text-center text-xs text-content-tertiary">
        <Link href="/reports" className="hover:text-primary-text">
          {t('reports.title')}
        </Link>
        {' · '}
        <Link href="/exchange/rates" className="hover:text-primary-text">
          {t('rates.title')}
        </Link>
        {' · '}
        <span>
          {t('dashboard.activeUsers')}: {data.activeUsers}
        </span>
      </p>
    </div>
  );
}
