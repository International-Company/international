import 'server-only';
import type { DbClient } from '@/core/db/prisma';
import { tellerResults } from '@/modules/ledger/teller-result.service';

/**
 * The office's reports, defined once and rendered three ways.
 *
 * A report that exists three times — a table on screen, a spreadsheet builder
 * and a print layout — is three things that drift. A column added to the screen
 * quietly stops appearing in the export, and nobody notices until the accountant
 * asks where it went. So each report is **one definition**: its columns, their
 * kinds, and a function that returns rows. The screen renders it, the exporter
 * writes it and the print page lays it out, all from the same list.
 *
 * ## On PDF
 *
 * There is no server-side PDF generation here, for the reason already written
 * on the receipt: Arabic needs bidirectional text and contextual letter shaping,
 * which the browser's text engine does correctly and most PDF libraries mangle
 * into disconnected letters running the wrong way. The print view is a real
 * page in the same fonts and the same translations, and every browser turns it
 * into a PDF on request. What that buys is a PDF that is actually readable in
 * Arabic — which is the only kind worth producing here.
 *
 * ## On the spreadsheet
 *
 * Money is written as a **number**, never as text. A column of amounts that
 * cannot be summed is a picture of a report rather than a report, and the first
 * thing anybody does with an export is select a column and look at the total.
 */

export type ColumnKind = 'text' | 'money' | 'rate' | 'date' | 'number' | 'code';

export interface ReportColumn {
  key: string;
  labelEn: string;
  labelAr: string;
  kind: ColumnKind;
  /** For money: how many decimals this column's currency carries. */
  decimals?: number;
  /** For money: the column holding the currency code, when it varies by row. */
  currencyKey?: string;
}

export interface ReportFilters {
  branchId: string;
  from: Date;
  to: Date;
  tellerId?: string;
}

export interface ReportDefinition {
  key: string;
  nameEn: string;
  nameAr: string;
  /** What somebody must hold to run it. */
  permission: string;
  columns: ReportColumn[];
  run(filters: ReportFilters, db: DbClient): Promise<Record<string, unknown>[]>;
}

const text = (key: string, labelEn: string, labelAr: string): ReportColumn => ({
  key,
  labelEn,
  labelAr,
  kind: 'text',
});
const money = (key: string, labelEn: string, labelAr: string, currencyKey?: string): ReportColumn => ({
  key,
  labelEn,
  labelAr,
  kind: 'money',
  currencyKey,
});

export const REPORTS: ReportDefinition[] = [
  // --- What crossed the counter -------------------------------------------
  {
    key: 'transactions',
    nameEn: 'Transactions',
    nameAr: 'العمليات',
    permission: 'exchange.transaction.viewAll',
    columns: [
      text('reference', 'Reference', 'الرقم'),
      { key: 'at', labelEn: 'When', labelAr: 'التاريخ', kind: 'date' },
      text('teller', 'Teller', 'التلر'),
      { key: 'type', labelEn: 'Kind', labelAr: 'النوع', kind: 'code' },
      text('fromCurrency', 'Paid', 'المدفوع'),
      money('fromAmount', 'Amount in', 'المبلغ الداخل', 'fromCurrency'),
      text('toCurrency', 'Received', 'المستلم'),
      money('toAmount', 'Amount out', 'المبلغ الخارج', 'toCurrency'),
      { key: 'rate', labelEn: 'Rate', labelAr: 'السعر', kind: 'rate' },
      money('margin', 'Margin', 'الهامش', 'toCurrency'),
      text('customer', 'Customer', 'العميل'),
      { key: 'status', labelEn: 'Status', labelAr: 'الحالة', kind: 'code' },
    ],
    async run({ branchId, from, to, tellerId }, db) {
      const rows = await db.transaction.findMany({
        where: {
          branchId,
          createdAt: { gte: from, lte: to },
          ...(tellerId ? { createdById: tellerId } : {}),
        },
        orderBy: { createdAt: 'asc' },
        include: {
          createdBy: { select: { fullNameEn: true, fullNameAr: true } },
          customer: { select: { fullNameEn: true, fullNameAr: true, code: true } },
        },
      });

      return rows.map((row) => ({
        reference: row.reference,
        at: row.createdAt,
        tellerEn: row.createdBy.fullNameEn,
        tellerAr: row.createdBy.fullNameAr,
        type: row.type,
        fromCurrency: row.fromCurrency,
        fromAmount: row.fromAmount,
        toCurrency: row.toCurrency,
        toAmount: row.toAmount,
        rate: row.rate,
        margin: row.profitAmount,
        customerEn: row.customer ? `${row.customer.fullNameEn} (${row.customer.code})` : '',
        customerAr: row.customer ? `${row.customer.fullNameAr} (${row.customer.code})` : '',
        status: row.status,
      }));
    },
  },

  // --- Every movement of every balance -------------------------------------
  {
    key: 'movements',
    nameEn: 'Balance movements',
    nameAr: 'حركات الصناديق',
    permission: 'exchange.drawer.view',
    columns: [
      { key: 'at', labelEn: 'When', labelAr: 'التاريخ', kind: 'date' },
      text('drawer', 'Balance', 'الصندوق'),
      text('holder', 'Held by', 'بيد'),
      { key: 'direction', labelEn: 'In / out', labelAr: 'الاتجاه', kind: 'code' },
      money('amount', 'Amount', 'المبلغ', 'currency'),
      money('balanceAfter', 'Balance after', 'الرصيد بعدها', 'currency'),
      { key: 'reason', labelEn: 'Reason', labelAr: 'السبب', kind: 'code' },
      text('note', 'Note', 'الملاحظة'),
      text('by', 'By', 'بواسطة'),
    ],
    async run({ from, to }, db) {
      const rows = await db.drawerMovement.findMany({
        where: { createdAt: { gte: from, lte: to } },
        orderBy: { createdAt: 'asc' },
        include: {
          drawer: {
            select: {
              currencyCode: true,
              kind: true,
              nameEn: true,
              nameAr: true,
              teller: { select: { fullNameEn: true, fullNameAr: true } },
            },
          },
          createdBy: { select: { fullNameEn: true, fullNameAr: true } },
        },
      });

      return rows.map((row) => ({
        at: row.createdAt,
        drawerEn: row.drawer.nameEn,
        drawerAr: row.drawer.nameAr,
        currency: row.drawer.currencyCode,
        holderEn: row.drawer.teller?.fullNameEn ?? 'Treasury',
        holderAr: row.drawer.teller?.fullNameAr ?? 'الخزينة',
        direction: row.direction,
        amount: row.amount,
        balanceAfter: row.balanceAfter,
        reason: row.reason,
        note: row.note ?? '',
        byEn: row.createdBy.fullNameEn,
        byAr: row.createdBy.fullNameAr,
      }));
    },
  },

  // --- What each teller gave the office ------------------------------------
  {
    key: 'tellers',
    nameEn: 'What each teller gave',
    nameAr: 'ما أعطاه كل تلر',
    permission: 'ledger.view',
    columns: [
      text('teller', 'Teller', 'التلر'),
      { key: 'deals', labelEn: 'Deals', labelAr: 'العمليات', kind: 'number' },
      money('margin', 'Margin', 'الهامش', 'base'),
      money('differences', 'Count differences', 'فروقات الجرد', 'base'),
      money('concessions', 'Prices given away', 'التنازلات', 'base'),
      money('net', 'What he gave', 'الصافي', 'base'),
      money('owed', 'Still owes', 'ما عليه', 'base'),
    ],
    async run({ branchId, from, to }, db) {
      const result = await tellerResults(branchId, from, to, db);
      return result.rows.map((row) => ({
        tellerEn: row.fullNameEn,
        tellerAr: row.fullNameAr,
        deals: row.deals,
        base: result.base,
        margin: row.margin,
        differences: row.differences,
        concessions: row.concessions,
        net: row.net,
        owed: row.owed,
      }));
    },
  },

  // --- Every gap the evening count found -----------------------------------
  {
    key: 'differences',
    nameEn: 'Count differences',
    nameAr: 'فروقات الجرد',
    permission: 'ledger.view',
    columns: [
      { key: 'at', labelEn: 'Found', labelAr: 'تاريخ الاكتشاف', kind: 'date' },
      text('shift', 'Shift', 'الورديّة'),
      text('teller', 'Teller', 'التلر'),
      text('currency', 'Currency', 'العملة'),
      money('shortage', 'Short', 'نقص', 'currency'),
      money('surplus', 'Over', 'زيادة', 'currency'),
      { key: 'status', labelEn: 'Status', labelAr: 'الحالة', kind: 'code' },
      { key: 'resolution', labelEn: 'Ruling', labelAr: 'القرار', kind: 'code' },
      text('note', 'Note', 'الملاحظة'),
    ],
    async run({ branchId, from, to, tellerId }, db) {
      const rows = await db.discrepancy.findMany({
        where: {
          createdAt: { gte: from, lte: to },
          shift: { branchId },
          ...(tellerId ? { tellerId } : {}),
        },
        orderBy: { createdAt: 'asc' },
        include: {
          teller: { select: { fullNameEn: true, fullNameAr: true } },
          shift: { select: { reference: true } },
        },
      });

      return rows.map((row) => ({
        at: row.createdAt,
        shift: row.shift.reference,
        tellerEn: row.teller.fullNameEn,
        tellerAr: row.teller.fullNameAr,
        currency: row.currencyCode,
        // Split into two columns so a spreadsheet can total each on its own
        // rather than the two silently cancelling in one signed column.
        shortage: row.amount > 0n ? row.amount : 0n,
        surplus: row.amount < 0n ? -row.amount : 0n,
        status: row.status,
        resolution: row.resolution ?? '',
        note: row.resolutionNote ?? '',
      }));
    },
  },
];

export const REPORTS_BY_KEY = new Map(REPORTS.map((report) => [report.key, report]));
