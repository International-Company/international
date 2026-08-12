import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import * as audit from '@/modules/audit/audit.service';
import {
  REPORTS,
  REPORTS_BY_KEY,
  type ReportColumn,
  type ReportDefinition,
  type ReportFilters,
} from './report.catalog';

/**
 * Running a report, and turning it into a spreadsheet.
 *
 * A row's localised fields arrive as `somethingEn` / `somethingAr` pairs, and a
 * single place collapses them to the reader's language. That way the definition
 * never has to know which language it is being read in, and the export, the
 * screen and the print page cannot disagree about it.
 */

const log = createLogger('reports');

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
  branchId?: string | null;
}

/**
 * Which reports this person may actually run.
 *
 * Takes the permissions rather than a whole actor, so a screen can ask it with
 * nothing but a session in hand.
 */
export function availableTo(permissions: string[]): ReportDefinition[] {
  return REPORTS.filter((report) => permissions.includes(report.permission));
}

function definitionFor(key: string, actor: Actor): ReportDefinition {
  const report = REPORTS_BY_KEY.get(key);
  if (!report) throw errors.notFound('Report', key);
  if (!actor.permissions.includes(report.permission)) throw errors.forbidden(report.permission);
  return report;
}

export interface RanReport {
  key: string;
  nameEn: string;
  nameAr: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  from: string;
  to: string;
  count: number;
}

/**
 * Runs a report and returns it with its own column list.
 *
 * Values stay in their raw shapes — `bigint` for money, `Date` for a date —
 * because each rendering wants something different from them: the screen wants
 * the reader's formatting, the spreadsheet wants a real number, and neither is
 * served by a service that turns everything into strings first.
 */
export async function run(
  key: string,
  filters: ReportFilters,
  actor: Actor,
  db: DbClient = prisma,
): Promise<RanReport> {
  const report = definitionFor(key, actor);
  const rows = await report.run(filters, db);

  log.info('Report run', { key, rows: rows.length });

  return {
    key: report.key,
    nameEn: report.nameEn,
    nameAr: report.nameAr,
    columns: report.columns,
    rows,
    from: filters.from.toISOString(),
    to: filters.to.toISOString(),
    count: rows.length,
  };
}

/** Picks the reader's half of a `…En` / `…Ar` pair, or the plain field. */
export function localised(
  row: Record<string, unknown>,
  column: ReportColumn,
  locale: 'ar' | 'en',
): unknown {
  const suffixed = row[`${column.key}${locale === 'ar' ? 'Ar' : 'En'}`];
  return suffixed !== undefined ? suffixed : row[column.key];
}

// ---------------------------------------------------------------------------
// The spreadsheet
// ---------------------------------------------------------------------------

const SCALE = 100000000n;

/**
 * Money as a number a spreadsheet can add up.
 *
 * Scaled amounts are `bigint`, and a column of text is a picture of a report
 * rather than a report — the first thing anybody does with an export is select
 * a column and read the total off the status bar. The division is exact for
 * every amount this system can hold: the scaled value would have to exceed
 * ninety trillion units before a double lost the last agura.
 */
function asNumber(value: bigint): number {
  return Number(value) / Number(SCALE);
}

function formatFor(kind: ReportColumn['kind'], decimals: number): string | undefined {
  if (kind === 'money') return decimals === 3 ? '#,##0.000' : '#,##0.00';
  if (kind === 'rate') return '#,##0.0000';
  if (kind === 'date') return 'yyyy-mm-dd hh:mm';
  return undefined;
}

/**
 * Writes the report as a real `.xlsx`.
 *
 * Right-to-left when the reader is reading Arabic, because a sheet that opens
 * with column A on the left puts the first column where an Arabic reader's eye
 * finishes rather than where it starts.
 */
export async function toWorkbook(
  report: RanReport,
  locale: 'ar' | 'en',
  decimalsOf: Map<string, number>,
): Promise<Buffer> {
  // Imported here rather than at the top: it is a large dependency that only
  // this one path needs, and every other request pays for a module it loads.
  const ExcelJS = (await import('exceljs')).default;

  const book = new ExcelJS.Workbook();
  book.creator = 'International';
  book.created = new Date();

  const sheet = book.addWorksheet(locale === 'ar' ? report.nameAr : report.nameEn, {
    views: [{ rightToLeft: locale === 'ar', state: 'frozen', ySplit: 1 }],
  });

  sheet.columns = report.columns.map((column) => ({
    header: locale === 'ar' ? column.labelAr : column.labelEn,
    key: column.key,
    width: column.kind === 'date' ? 20 : column.kind === 'text' ? 24 : 16,
  }));

  sheet.getRow(1).font = { bold: true };

  for (const row of report.rows) {
    const cells: Record<string, unknown> = {};

    for (const column of report.columns) {
      const value = localised(row, column, locale);

      if (value === null || value === undefined) {
        cells[column.key] = '';
      } else if (column.kind === 'money' || column.kind === 'rate') {
        cells[column.key] = asNumber(value as bigint);
      } else {
        cells[column.key] = value;
      }
    }

    const written = sheet.addRow(cells);

    // The number format follows the row's own currency, so a dinar column shows
    // its third decimal and a shekel column does not.
    for (const [index, column] of report.columns.entries()) {
      const currency = column.currencyKey ? String(row[column.currencyKey] ?? '') : '';
      const format = formatFor(column.kind, decimalsOf.get(currency) ?? 2);
      if (format) written.getCell(index + 1).numFmt = format;
    }
  }

  const buffer = await book.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Notes that somebody took a copy of the office's figures out of the system.
 *
 * An export is the one action that puts the books somewhere the system can no
 * longer see, so it is written down like any other act of consequence.
 */
export async function recordExport(
  report: RanReport,
  format: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await audit.record(
    {
      action: 'EXPORT',
      module: 'exchange',
      entityType: 'Report',
      entityId: report.key,
      summaryEn: `Exported "${report.nameEn}" as ${format} — ${report.count} row(s)`,
      summaryAr: `تصدير "${report.nameAr}" بصيغة ${format} — ${report.count} سطر`,
      actor,
      after: { from: report.from, to: report.to, rows: report.count },
    },
    db,
  );
}
