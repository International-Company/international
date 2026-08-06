import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { trialBalance } from '@/modules/ledger/ledger.service';
import { TRANSACTION_TYPE_META, type TransactionType } from '@/modules/exchange/posting-rules';

/**
 * Reporting.
 *
 * Every report is a pure read against POSTED transactions and the ledger.
 * Drafts and rejected work never appear: a report that includes unposted
 * amounts is not a financial report, it is a guess.
 *
 * Totals are always grouped per currency. There is no consolidated grand total,
 * because adding shekels to dollars produces a number that means nothing.
 */

export type ReportKey =
  | 'transactionSummary'
  | 'dailyActivity'
  | 'trialBalance'
  | 'cashPosition'
  | 'customerActivity'
  | 'profitAnalysis'
  | 'usdtFlow';

export const REPORTS: { key: ReportKey; permission: string }[] = [
  { key: 'transactionSummary', permission: 'reports.view' },
  { key: 'dailyActivity', permission: 'reports.view' },
  { key: 'trialBalance', permission: 'reports.financial.view' },
  { key: 'cashPosition', permission: 'reports.financial.view' },
  { key: 'customerActivity', permission: 'reports.view' },
  { key: 'profitAnalysis', permission: 'reports.financial.view' },
  { key: 'usdtFlow', permission: 'reports.view' },
];

export interface ReportRange {
  from: Date;
  to: Date;
  branchId?: string;
}

export interface ReportColumn {
  key: string;
  labelEn: string;
  labelAr: string;
  type: 'text' | 'money' | 'number' | 'date';
  /** Currency code, or `row` to read it from the row's `currency` field. */
  currency?: string;
}

export interface ReportResult {
  key: ReportKey;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  generatedAt: Date;
  range: { from: Date; to: Date };
}

const POSTED = { status: 'POSTED' } as const;

function rangeWhere(range: ReportRange) {
  return {
    ...POSTED,
    valueDate: { gte: range.from, lte: range.to },
    ...(range.branchId ? { branchId: range.branchId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Transaction summary
// ---------------------------------------------------------------------------

async function transactionSummary(range: ReportRange, db: DbClient): Promise<ReportResult> {
  const grouped = await db.transaction.groupBy({
    by: ['type', 'fromCurrency'],
    where: rangeWhere(range),
    _count: { _all: true },
    _sum: { fromAmount: true, feeAmount: true, profitAmount: true },
  });

  const rows = grouped
    .map((group) => {
      const meta = TRANSACTION_TYPE_META[group.type as TransactionType];
      const volume = group._sum.fromAmount ?? 0n;
      const count = group._count._all;

      return {
        type: group.type,
        typeEn: meta?.nameEn ?? group.type,
        typeAr: meta?.nameAr ?? group.type,
        currency: group.fromCurrency,
        count,
        volume,
        // Integer division keeps the average exact in minor units.
        average: count > 0 ? volume / BigInt(count) : 0n,
        fees: group._sum.feeAmount ?? 0n,
        profit: group._sum.profitAmount ?? 0n,
      };
    })
    .sort((a, b) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0));

  const totals: Record<string, unknown> = {};
  for (const row of rows) {
    const current = (totals[row.currency] as { count: number; volume: bigint } | undefined) ?? {
      count: 0,
      volume: 0n,
    };
    totals[row.currency] = { count: current.count + row.count, volume: current.volume + row.volume };
  }

  return {
    key: 'transactionSummary',
    columns: [
      { key: 'typeEn', labelEn: 'Type', labelAr: 'النوع', type: 'text' },
      { key: 'currency', labelEn: 'Currency', labelAr: 'العملة', type: 'text' },
      { key: 'count', labelEn: 'Count', labelAr: 'العدد', type: 'number' },
      { key: 'volume', labelEn: 'Volume', labelAr: 'الحجم', type: 'money', currency: 'row' },
      { key: 'average', labelEn: 'Average', labelAr: 'المتوسط', type: 'money', currency: 'row' },
      { key: 'fees', labelEn: 'Commission', labelAr: 'العمولات', type: 'money', currency: 'row' },
      { key: 'profit', labelEn: 'Spread', labelAr: 'الهامش', type: 'money', currency: 'row' },
    ],
    rows,
    totals,
    generatedAt: new Date(),
    range: { from: range.from, to: range.to },
  };
}

// ---------------------------------------------------------------------------
// Daily activity
// ---------------------------------------------------------------------------

async function dailyActivity(range: ReportRange, db: DbClient): Promise<ReportResult> {
  const transactions = await db.transaction.findMany({
    where: rangeWhere(range),
    select: {
      valueDate: true,
      fromCurrency: true,
      fromAmount: true,
      profitAmount: true,
      feeAmount: true,
    },
    orderBy: { valueDate: 'asc' },
  });

  // Grouping by calendar day in application code rather than SQL keeps this
  // correct across time zones and portable across database engines.
  const buckets = new Map<
    string,
    { date: string; currency: string; count: number; volume: bigint; profit: bigint; fees: bigint }
  >();

  for (const transaction of transactions) {
    const day = transaction.valueDate.toISOString().slice(0, 10);
    const key = `${day}|${transaction.fromCurrency}`;

    const bucket =
      buckets.get(key) ??
      {
        date: day,
        currency: transaction.fromCurrency,
        count: 0,
        volume: 0n,
        profit: 0n,
        fees: 0n,
      };

    bucket.count++;
    bucket.volume += transaction.fromAmount;
    bucket.profit += transaction.profitAmount;
    bucket.fees += transaction.feeAmount;
    buckets.set(key, bucket);
  }

  const rows = [...buckets.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency),
  );

  return {
    key: 'dailyActivity',
    columns: [
      { key: 'date', labelEn: 'Date', labelAr: 'التاريخ', type: 'text' },
      { key: 'currency', labelEn: 'Currency', labelAr: 'العملة', type: 'text' },
      { key: 'count', labelEn: 'Transactions', labelAr: 'العمليات', type: 'number' },
      { key: 'volume', labelEn: 'Volume', labelAr: 'الحجم', type: 'money', currency: 'row' },
      { key: 'fees', labelEn: 'Commission', labelAr: 'العمولات', type: 'money', currency: 'row' },
      { key: 'profit', labelEn: 'Spread', labelAr: 'الهامش', type: 'money', currency: 'row' },
    ],
    rows,
    generatedAt: new Date(),
    range: { from: range.from, to: range.to },
  };
}

// ---------------------------------------------------------------------------
// Cash position
// ---------------------------------------------------------------------------

async function cashPosition(range: ReportRange, db: DbClient): Promise<ReportResult> {
  const accounts = await db.account.findMany({
    where: {
      isActive: true,
      kind: { in: ['CASH', 'BANK', 'CRYPTO'] },
      ...(range.branchId ? { OR: [{ branchId: range.branchId }, { branchId: null }] } : {}),
    },
    orderBy: [{ currencyCode: 'asc' }, { sortOrder: 'asc' }],
  });

  const rows = accounts.map((account) => ({
    code: account.code,
    nameEn: account.nameEn,
    nameAr: account.nameAr,
    kind: account.kind,
    currency: account.currencyCode,
    balance: account.balance,
  }));

  const totals: Record<string, bigint> = {};
  for (const row of rows) {
    totals[row.currency] = (totals[row.currency] ?? 0n) + row.balance;
  }

  return {
    key: 'cashPosition',
    columns: [
      { key: 'code', labelEn: 'Code', labelAr: 'الرمز', type: 'text' },
      { key: 'nameEn', labelEn: 'Account', labelAr: 'الحساب', type: 'text' },
      { key: 'kind', labelEn: 'Kind', labelAr: 'الصنف', type: 'text' },
      { key: 'currency', labelEn: 'Currency', labelAr: 'العملة', type: 'text' },
      { key: 'balance', labelEn: 'Balance', labelAr: 'الرصيد', type: 'money', currency: 'row' },
    ],
    rows,
    totals,
    generatedAt: new Date(),
    range: { from: range.from, to: range.to },
  };
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

async function trialBalanceReport(range: ReportRange, db: DbClient): Promise<ReportResult> {
  const { rows, totals } = await trialBalance({ asOf: range.to, branchId: range.branchId }, db);

  return {
    key: 'trialBalance',
    columns: [
      { key: 'code', labelEn: 'Code', labelAr: 'الرمز', type: 'text' },
      { key: 'nameEn', labelEn: 'Account', labelAr: 'الحساب', type: 'text' },
      { key: 'type', labelEn: 'Type', labelAr: 'النوع', type: 'text' },
      { key: 'currencyCode', labelEn: 'Currency', labelAr: 'العملة', type: 'text' },
      { key: 'debit', labelEn: 'Debit', labelAr: 'مدين', type: 'money', currency: 'row' },
      { key: 'credit', labelEn: 'Credit', labelAr: 'دائن', type: 'money', currency: 'row' },
      { key: 'balance', labelEn: 'Balance', labelAr: 'الرصيد', type: 'money', currency: 'row' },
    ],
    rows: rows.map((row) => ({ ...row, currency: row.currencyCode })),
    totals: totals as unknown as Record<string, unknown>,
    generatedAt: new Date(),
    range: { from: range.from, to: range.to },
  };
}

// ---------------------------------------------------------------------------
// Customer activity
// ---------------------------------------------------------------------------

async function customerActivity(range: ReportRange, db: DbClient): Promise<ReportResult> {
  const grouped = await db.transaction.groupBy({
    by: ['customerId', 'fromCurrency'],
    where: { ...rangeWhere(range), customerId: { not: null } },
    _count: { _all: true },
    _sum: { fromAmount: true },
  });

  const customerIds = [...new Set(grouped.map((g) => g.customerId).filter(Boolean))] as string[];
  const customers = await db.customer.findMany({
    where: { id: { in: customerIds } },
    select: { id: true, code: true, fullNameEn: true, fullNameAr: true, riskLevel: true },
  });
  const byId = new Map(customers.map((c) => [c.id, c]));

  const rows = grouped
    .map((group) => {
      const customer = byId.get(group.customerId!);
      return {
        code: customer?.code ?? '—',
        nameEn: customer?.fullNameEn ?? '—',
        nameAr: customer?.fullNameAr ?? '—',
        riskLevel: customer?.riskLevel ?? 'LOW',
        currency: group.fromCurrency,
        count: group._count._all,
        volume: group._sum.fromAmount ?? 0n,
      };
    })
    .sort((a, b) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0));

  return {
    key: 'customerActivity',
    columns: [
      { key: 'code', labelEn: 'Code', labelAr: 'الرمز', type: 'text' },
      { key: 'nameEn', labelEn: 'Customer', labelAr: 'العميل', type: 'text' },
      { key: 'riskLevel', labelEn: 'Risk', labelAr: 'المخاطر', type: 'text' },
      { key: 'currency', labelEn: 'Currency', labelAr: 'العملة', type: 'text' },
      { key: 'count', labelEn: 'Transactions', labelAr: 'العمليات', type: 'number' },
      { key: 'volume', labelEn: 'Volume', labelAr: 'الحجم', type: 'money', currency: 'row' },
    ],
    rows,
    generatedAt: new Date(),
    range: { from: range.from, to: range.to },
  };
}

// ---------------------------------------------------------------------------
// Spread analysis
// ---------------------------------------------------------------------------

async function profitAnalysis(range: ReportRange, db: DbClient): Promise<ReportResult> {
  const grouped = await db.transaction.groupBy({
    by: ['fromCurrency', 'toCurrency'],
    where: { ...rangeWhere(range), type: 'EXCHANGE' },
    _count: { _all: true },
    _sum: { fromAmount: true, toAmount: true, profitAmount: true },
  });

  const rows = grouped
    .map((group) => ({
      pair: `${group.fromCurrency}/${group.toCurrency}`,
      fromCurrency: group.fromCurrency,
      currency: group.toCurrency,
      count: group._count._all,
      volumeFrom: group._sum.fromAmount ?? 0n,
      volumeTo: group._sum.toAmount ?? 0n,
      profit: group._sum.profitAmount ?? 0n,
    }))
    .sort((a, b) => (b.profit > a.profit ? 1 : b.profit < a.profit ? -1 : 0));

  const totals: Record<string, bigint> = {};
  for (const row of rows) {
    totals[row.currency] = (totals[row.currency] ?? 0n) + row.profit;
  }

  return {
    key: 'profitAnalysis',
    columns: [
      { key: 'pair', labelEn: 'Pair', labelAr: 'الزوج', type: 'text' },
      { key: 'count', labelEn: 'Trades', labelAr: 'الصفقات', type: 'number' },
      { key: 'volumeTo', labelEn: 'Delivered', labelAr: 'المسلّم', type: 'money', currency: 'row' },
      { key: 'profit', labelEn: 'Spread', labelAr: 'الهامش', type: 'money', currency: 'row' },
    ],
    rows,
    totals,
    generatedAt: new Date(),
    range: { from: range.from, to: range.to },
  };
}

// ---------------------------------------------------------------------------
// USDT flow
// ---------------------------------------------------------------------------

async function usdtFlow(range: ReportRange, db: DbClient): Promise<ReportResult> {
  const grouped = await db.chainTransaction.groupBy({
    by: ['direction', 'network', 'tokenSymbol'],
    where: {
      status: 'CONFIRMED',
      blockTimestamp: { gte: range.from, lte: range.to },
    },
    _count: { _all: true },
    _sum: { amount: true, networkFee: true },
  });

  const rows = grouped.map((group) => ({
    direction: group.direction,
    network: group.network,
    currency: group.tokenSymbol,
    count: group._count._all,
    amount: group._sum.amount ?? 0n,
    fees: group._sum.networkFee ?? 0n,
  }));

  const inflow = rows
    .filter((r) => r.direction === 'IN')
    .reduce((sum, r) => sum + r.amount, 0n);
  const outflow = rows
    .filter((r) => r.direction === 'OUT')
    .reduce((sum, r) => sum + r.amount, 0n);

  return {
    key: 'usdtFlow',
    columns: [
      { key: 'direction', labelEn: 'Direction', labelAr: 'الاتجاه', type: 'text' },
      { key: 'network', labelEn: 'Network', labelAr: 'الشبكة', type: 'text' },
      { key: 'currency', labelEn: 'Token', labelAr: 'العملة', type: 'text' },
      { key: 'count', labelEn: 'Transfers', labelAr: 'التحويلات', type: 'number' },
      { key: 'amount', labelEn: 'Amount', labelAr: 'المبلغ', type: 'money', currency: 'row' },
    ],
    rows,
    totals: { inflow, outflow, net: inflow - outflow },
    generatedAt: new Date(),
    range: { from: range.from, to: range.to },
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const RUNNERS: Record<ReportKey, (range: ReportRange, db: DbClient) => Promise<ReportResult>> = {
  transactionSummary,
  dailyActivity,
  trialBalance: trialBalanceReport,
  cashPosition,
  customerActivity,
  profitAnalysis,
  usdtFlow,
};

export async function runReport(
  key: ReportKey,
  range: ReportRange,
  db: DbClient = prisma,
): Promise<ReportResult> {
  const runner = RUNNERS[key];
  if (!runner) throw errors.notFound('Report', key);

  if (range.from > range.to) {
    throw errors.validation([{ path: 'from', message: 'Start date must not be after the end date' }]);
  }

  return runner(range, db);
}

export function permissionFor(key: ReportKey): string {
  return REPORTS.find((report) => report.key === key)?.permission ?? 'reports.view';
}
