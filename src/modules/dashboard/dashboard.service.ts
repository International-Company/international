import 'server-only';
import { prisma } from '@/core/db/prisma';
import { dayBounds } from '@/modules/exchange/business-day.service';
import { rateBoard } from '@/modules/exchange/rates.service';
import { portfolio } from '@/modules/usdt/wallet.service';
import * as queue from '@/core/jobs/queue';

/**
 * Dashboard aggregation.
 *
 * Assembled in one place so the page performs a single round of parallel
 * queries rather than a waterfall of per-widget fetches. Everything respects
 * the caller's permissions: a teller sees their own numbers, a manager sees the
 * branch's.
 */

export interface DashboardContext {
  userId: string;
  permissions: string[];
  branchId: string | null;
}

export async function loadDashboard(context: DashboardContext) {
  const { start, end } = dayBounds(new Date());
  const canSeeAll = context.permissions.includes('exchange.transaction.viewAll');
  const canSeeFinancials = context.permissions.includes('dashboard.financials.view');

  const scope = canSeeAll ? {} : { createdById: context.userId };

  const [
    todayGroups,
    todayCount,
    pendingCount,
    recentTransactions,
    accounts,
    rates,
    usdtPortfolio,
    activity,
    trend,
    activeUsers,
    queueStats,
    lastBackup,
  ] = await Promise.all([
    // Volume by currency for today
    prisma.transaction.groupBy({
      by: ['fromCurrency'],
      where: { ...scope, status: 'POSTED', valueDate: { gte: start, lte: end } },
      _sum: { fromAmount: true, profitAmount: true },
      _count: { _all: true },
    }),

    prisma.transaction.count({
      where: { ...scope, status: 'POSTED', valueDate: { gte: start, lte: end } },
    }),

    prisma.transaction.count({
      where: {
        status: 'PENDING_APPROVAL',
        ...(canSeeAll ? {} : { createdById: context.userId }),
      },
    }),

    prisma.transaction.findMany({
      where: scope,
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: {
        id: true,
        reference: true,
        type: true,
        status: true,
        fromCurrency: true,
        fromAmount: true,
        toCurrency: true,
        toAmount: true,
        createdAt: true,
        customer: { select: { fullNameEn: true, fullNameAr: true } },
        createdBy: { select: { fullNameEn: true, fullNameAr: true } },
      },
    }),

    canSeeFinancials
      ? prisma.account.findMany({
          where: { isActive: true, kind: { in: ['CASH', 'BANK', 'CRYPTO'] } },
          orderBy: [{ currencyCode: 'asc' }, { sortOrder: 'asc' }],
          select: {
            id: true,
            code: true,
            nameEn: true,
            nameAr: true,
            kind: true,
            currencyCode: true,
            balance: true,
          },
        })
      : Promise.resolve([]),

    rateBoard(),

    context.permissions.includes('usdt.wallet.view') ? portfolio() : Promise.resolve(null),

    // Activity timeline — the audit log is already the record of what happened.
    prisma.auditLog.findMany({
      where: canSeeAll ? {} : { actorId: context.userId },
      orderBy: { id: 'desc' },
      take: 12,
      select: {
        id: true,
        at: true,
        action: true,
        module: true,
        summaryEn: true,
        summaryAr: true,
        actorName: true,
        entityType: true,
        entityId: true,
      },
    }),

    volumeTrend(context, 14),

    prisma.session.count({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
    }),

    context.permissions.includes('system.monitor') ? queue.stats() : Promise.resolve(null),

    context.permissions.includes('system.backup.view')
      ? prisma.backup.findFirst({
          where: { status: { in: ['COMPLETED', 'VERIFIED'] } },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true, status: true, filename: true },
        })
      : Promise.resolve(null),
  ]);

  const todayVolume = todayGroups.map((group) => ({
    currency: group.fromCurrency,
    volume: group._sum.fromAmount ?? 0n,
    profit: group._sum.profitAmount ?? 0n,
    count: group._count._all,
  }));

  return {
    today: {
      count: todayCount,
      volume: todayVolume,
      profit: todayVolume.reduce((sum, entry) => sum + entry.profit, 0n),
    },
    pendingCount,
    recentTransactions,
    accounts,
    rates,
    usdtPortfolio,
    activity,
    trend,
    activeUsers,
    queueStats,
    lastBackup,
    canSeeFinancials,
  };
}

/** Daily posted volume for the trend chart, one series per day. */
async function volumeTrend(context: DashboardContext, days: number) {
  const from = new Date();
  from.setDate(from.getDate() - (days - 1));
  from.setHours(0, 0, 0, 0);

  const transactions = await prisma.transaction.findMany({
    where: {
      status: 'POSTED',
      valueDate: { gte: from },
      ...(context.permissions.includes('exchange.transaction.viewAll')
        ? {}
        : { createdById: context.userId }),
    },
    select: { valueDate: true, fromAmount: true, fromCurrency: true },
  });

  const buckets = new Map<string, { date: string; count: number; volume: bigint }>();

  // Pre-seed every day so the chart shows a flat line on quiet days rather
  // than silently compressing the axis.
  for (let index = 0; index < days; index++) {
    const day = new Date(from);
    day.setDate(from.getDate() + index);
    const key = day.toISOString().slice(0, 10);
    buckets.set(key, { date: key, count: 0, volume: 0n });
  }

  for (const transaction of transactions) {
    const key = transaction.valueDate.toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.count++;
    bucket.volume += transaction.fromAmount;
  }

  return [...buckets.values()];
}
