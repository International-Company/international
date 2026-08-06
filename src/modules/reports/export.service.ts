import 'server-only';
import ExcelJS from 'exceljs';
import { toDecimalString } from '@/core/money/money';
import type { Locale } from '@/i18n/config';
import type { ReportColumn, ReportResult } from './reports.service';

/**
 * Report exports.
 *
 * Excel is generated server-side so the file the accountant opens is byte-for-byte
 * the numbers the ledger holds — no client-side re-derivation, no rounding
 * introduced by a spreadsheet library reading floats.
 *
 * Money is written as a real number with an explicit format, not as text, so the
 * recipient can actually sum a column. The conversion from scaled bigint to a
 * spreadsheet number happens exactly once, here, at the boundary.
 */

export interface ExportContext {
  locale: Locale;
  title: string;
  subtitle?: string;
  companyName: string;
  generatedBy: string;
}

function cellValue(column: ReportColumn, row: Record<string, unknown>): string | number {
  const raw = row[column.key];

  if (raw === null || raw === undefined) return '';

  switch (column.type) {
    case 'money': {
      const amount = typeof raw === 'bigint' ? raw : BigInt(String(raw));
      // Excel's numeric type is a double; a decimal string keeps the value
      // exact through the conversion for any realistic transaction size.
      return Number(toDecimalString(amount, 2));
    }
    case 'number':
      return Number(raw);
    case 'date':
      return raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw);
    default:
      return String(raw);
  }
}

function headerFor(column: ReportColumn, locale: Locale): string {
  return locale === 'ar' ? column.labelAr : column.labelEn;
}

/** Arabic reports read right-to-left, including the sheet itself. */
function localizedColumns(columns: ReportColumn[], locale: Locale): ReportColumn[] {
  if (locale !== 'ar') return columns;

  // Swap English-name columns for their Arabic twin where the report provides one.
  return columns.map((column) =>
    column.key.endsWith('En') ? { ...column, key: column.key.replace(/En$/, 'Ar') } : column,
  );
}

export async function toExcel(report: ReportResult, context: ExportContext): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = context.companyName;
  workbook.created = report.generatedAt;

  const sheet = workbook.addWorksheet(context.title.slice(0, 30), {
    views: [
      {
        rightToLeft: context.locale === 'ar',
        // Freeze the header block so column names stay visible while scrolling.
        state: 'frozen',
        ySplit: 5,
      },
    ],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const columns = localizedColumns(report.columns, context.locale);

  // --- Title block ---------------------------------------------------------
  sheet.mergeCells(1, 1, 1, Math.max(columns.length, 2));
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = context.companyName;
  titleCell.font = { size: 14, bold: true };
  titleCell.alignment = { horizontal: context.locale === 'ar' ? 'right' : 'left' };

  sheet.mergeCells(2, 1, 2, Math.max(columns.length, 2));
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = context.title;
  subtitleCell.font = { size: 11, bold: true, color: { argb: 'FF1D4ED8' } };
  subtitleCell.alignment = { horizontal: context.locale === 'ar' ? 'right' : 'left' };

  sheet.mergeCells(3, 1, 3, Math.max(columns.length, 2));
  const metaCell = sheet.getCell(3, 1);
  metaCell.value =
    `${report.range.from.toISOString().slice(0, 10)} → ${report.range.to.toISOString().slice(0, 10)}` +
    `   ·   ${report.generatedAt.toISOString().slice(0, 16).replace('T', ' ')}` +
    `   ·   ${context.generatedBy}`;
  metaCell.font = { size: 9, color: { argb: 'FF6B7280' } };
  metaCell.alignment = { horizontal: context.locale === 'ar' ? 'right' : 'left' };

  // --- Header row ----------------------------------------------------------
  const headerRow = sheet.getRow(5);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = headerFor(column, context.locale);
    cell.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });
  headerRow.height = 22;

  // --- Data ----------------------------------------------------------------
  report.rows.forEach((row, rowIndex) => {
    const sheetRow = sheet.getRow(6 + rowIndex);

    columns.forEach((column, columnIndex) => {
      const cell = sheetRow.getCell(columnIndex + 1);
      cell.value = cellValue(column, row);
      cell.font = { size: 10 };

      if (column.type === 'money') {
        cell.numFmt = '#,##0.00';
        cell.alignment = { horizontal: 'right' };
      } else if (column.type === 'number') {
        cell.numFmt = '#,##0';
        cell.alignment = { horizontal: 'right' };
      } else {
        cell.alignment = { horizontal: context.locale === 'ar' ? 'right' : 'left' };
      }

      // Banded rows — subtle, because this is a document people read for hours.
      if (rowIndex % 2 === 1) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF7F8FA' } };
      }
    });
  });

  // --- Totals --------------------------------------------------------------
  if (report.totals && Object.keys(report.totals).length > 0) {
    const totalsStart = 6 + report.rows.length + 1;
    let offset = 0;

    for (const [key, value] of Object.entries(report.totals)) {
      const row = sheet.getRow(totalsStart + offset);

      const labelCell = row.getCell(1);
      labelCell.value = context.locale === 'ar' ? `الإجمالي — ${key}` : `Total — ${key}`;
      labelCell.font = { bold: true, size: 10 };

      const valueCell = row.getCell(2);
      if (typeof value === 'bigint') {
        valueCell.value = Number(toDecimalString(value, 2));
        valueCell.numFmt = '#,##0.00';
      } else if (value && typeof value === 'object') {
        const summary = value as { count?: number; volume?: bigint };
        valueCell.value =
          summary.volume !== undefined ? Number(toDecimalString(summary.volume, 2)) : '';
        valueCell.numFmt = '#,##0.00';
        if (summary.count !== undefined) row.getCell(3).value = summary.count;
      } else {
        valueCell.value = String(value);
      }
      valueCell.font = { bold: true, size: 10 };

      offset++;
    }
  }

  // --- Sizing --------------------------------------------------------------
  columns.forEach((column, index) => {
    const header = headerFor(column, context.locale).length;
    const widest = report.rows.reduce((max, row) => {
      const text = String(cellValue(column, row));
      return Math.max(max, text.length);
    }, header);

    sheet.getColumn(index + 1).width = Math.min(40, Math.max(12, widest + 3));
  });

  sheet.autoFilter = {
    from: { row: 5, column: 1 },
    to: { row: 5, column: columns.length },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function escapeCsv(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(report: ReportResult, context: ExportContext): string {
  const columns = localizedColumns(report.columns, context.locale);

  const lines = [
    columns.map((column) => escapeCsv(headerFor(column, context.locale))).join(','),
    ...report.rows.map((row) =>
      columns.map((column) => escapeCsv(cellValue(column, row))).join(','),
    ),
  ];

  // A BOM makes Excel open UTF-8 CSV with Arabic intact instead of mojibake.
  return `﻿${lines.join('\r\n')}`;
}

/** Filesystem-safe, sortable export filename. */
export function exportFilename(reportKey: string, extension: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:]/g, '-');
  return `ifms-${reportKey}-${stamp}.${extension}`;
}
