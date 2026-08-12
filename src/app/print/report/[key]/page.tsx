import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireActiveSession } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { prisma } from '@/core/db/prisma';
import { formatAmount, formatDateTime } from '@/i18n/format';
import { toDecimalString } from '@/core/money/money';
import * as settings from '@/modules/settings/settings.service';
import * as reports from '@/modules/reports/report.service';
import { BRAND } from '@/app/_shell/brand';
import { AutoPrint } from '../../receipt/[id]/auto-print';

export const metadata: Metadata = { title: 'Report', robots: { index: false } };
export const dynamic = 'force-dynamic';

/**
 * A report on paper — and, by the same route, as a PDF.
 *
 * There is no server-side PDF here for the reason the receipt already gives:
 * Arabic needs bidirectional text and contextual letter shaping, and most PDF
 * libraries turn it into disconnected letters running the wrong way. This is a
 * real page in the system's own fonts and translations, and every browser turns
 * it into a PDF on request. The result is a PDF that is actually readable in
 * Arabic, which is the only kind worth producing for this office.
 *
 * It renders whatever the report says its columns are, so a report added to the
 * catalogue prints without anybody touching this file.
 */
function parseDay(value: string | undefined, fallback: Date, endOfDay = false): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const [year, month, day] = value.split('-').map(Number);
  return endOfDay
    ? new Date(year!, month! - 1, day!, 23, 59, 59, 999)
    : new Date(year!, month! - 1, day!);
}

export default async function ReportPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ from?: string; to?: string; tellerId?: string }>;
}) {
  const { key } = await params;
  const { from: fromRaw, to: toRaw, tellerId } = await searchParams;

  const session = await requireActiveSession();
  const { t, locale, isRtl } = await getTranslator();
  if (!session.user.branchId) notFound();

  const now = new Date();
  const to = parseDay(toRaw, now, true);
  const from = parseDay(fromRaw, new Date(to.getTime() - 30 * 86_400_000));

  let ran;
  try {
    ran = await reports.run(
      key,
      { branchId: session.user.branchId, from, to, tellerId },
      session.user as never,
    );
  } catch {
    // A report they may not run, or one that does not exist. Neither is worth
    // explaining on a page meant for a printer.
    notFound();
  }

  const [companyName, currencies] = await Promise.all([
    settings
      .getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en')
      .catch(() => t('app.name')),
    prisma.currency.findMany({ select: { code: true, decimals: true } }),
  ]);
  const decimalsOf = new Map(currencies.map((currency) => [currency.code, currency.decimals]));

  const numeric = (kind: string) => kind === 'money' || kind === 'rate' || kind === 'number';

  const render = (row: Record<string, unknown>, column: (typeof ran.columns)[number]) => {
    const value = reports.localised(row, column, locale);
    if (value === null || value === undefined || value === '') return '—';

    if (column.kind === 'money') {
      const currency = column.currencyKey ? String(row[column.currencyKey] ?? '') : undefined;
      return `${toDecimalString(value as bigint, decimalsOf.get(currency ?? '') ?? 2)}${
        currency ? ` ${currency}` : ''
      }`;
    }
    if (column.kind === 'rate') return toDecimalString(value as bigint, 4);
    if (column.kind === 'date') return formatDateTime(value as Date, locale);
    if (column.kind === 'number') return String(value);
    return String(value);
  };

  return (
    <div dir={isRtl ? 'rtl' : 'ltr'} className="mx-auto max-w-[1100px] p-6 text-black">
      <AutoPrint />

      <header className="mb-4 flex items-center gap-4 border-b border-black/30 pb-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- a fixed, hashed
            asset, and this page exists to be printed rather than optimised. */}
        <img src={BRAND.logoSmall} alt="" width={48} height={48} className="size-12" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-bold">{companyName}</p>
          <p className="text-sm">{locale === 'ar' ? ran.nameAr : ran.nameEn}</p>
        </div>
        <div className="text-end text-xs">
          <p>
            {t('reports.printedPeriod', {
              from: from.toISOString().slice(0, 10),
              to: to.toISOString().slice(0, 10),
            })}
          </p>
          <p>{t('reports.printedOn', { date: formatDateTime(now, locale) })}</p>
          <p>{t('reports.rows', { count: ran.count })}</p>
        </div>
      </header>

      {ran.count === 0 ? (
        <p className="py-10 text-center text-sm">{t('reports.noData')}</p>
      ) : (
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr>
              {ran.columns.map((column) => (
                <th
                  key={column.key}
                  className={`border border-black/40 bg-black/5 px-2 py-1 font-semibold ${
                    numeric(column.kind) ? 'text-end' : 'text-start'
                  }`}
                >
                  {locale === 'ar' ? column.labelAr : column.labelEn}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ran.rows.map((row, index) => (
              <tr key={index}>
                {ran.columns.map((column) => (
                  <td
                    key={column.key}
                    className={`border border-black/25 px-2 py-1 ${
                      numeric(column.kind) ? 'text-end tabular-nums' : 'text-start'
                    }`}
                    dir={numeric(column.kind) ? 'ltr' : undefined}
                  >
                    {render(row, column)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Only on screen: the person at the printer does not need telling. */}
      <p className="mt-4 text-center text-xs text-black/60 print:hidden">{t('reports.pdfHint')}</p>
    </div>
  );
}
