import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import * as audit from '@/modules/audit/audit.service';
import * as settings from '@/modules/settings/settings.service';
import { permissionFor, runReport, type ReportKey } from '@/modules/reports/reports.service';
import { exportFilename, toCsv, toExcel } from '@/modules/reports/export.service';
import { getLocale } from '@/i18n/server';
import { getDictionary } from '@/i18n/translate';

const paramsSchema = z.object({
  key: z.enum([
    'transactionSummary',
    'dailyActivity',
    'trialBalance',
    'cashPosition',
    'customerActivity',
    'profitAnalysis',
    'usdtFlow',
  ]),
});

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  branchId: z.string().optional(),
  format: z.enum(['json', 'xlsx', 'csv']).default('json'),
});

/** Defaults to the current month when no range is supplied. */
function resolveRange(query: { from?: Date; to?: Date }) {
  const to = query.to ?? new Date();
  const from = query.from ?? new Date(to.getFullYear(), to.getMonth(), 1);

  const start = new Date(from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  return { from: start, to: end };
}

export const GET = route<unknown, z.infer<typeof querySchema>, z.infer<typeof paramsSchema>>({
  paramsSchema,
  querySchema,
  rateLimit: { key: 'report', limit: 60, windowSeconds: 300 },
  handler: async ({ params, query, actor }) => {
    const key = params.key as ReportKey;

    const permission = permissionFor(key);
    if (!actor.permissions.includes(permission)) throw errors.forbidden(permission);

    const range = { ...resolveRange(query), branchId: query.branchId };
    const report = await runReport(key, range);

    if (query.format === 'json') return report;

    // Exporting financial data leaves the system, so it is always audited.
    if (!actor.permissions.includes('reports.export')) throw errors.forbidden('reports.export');

    const locale = await getLocale();
    const dictionary = getDictionary(locale);
    const reportLabels = dictionary.reports as unknown as Record<string, string>;

    const context = {
      locale,
      title: reportLabels[key] ?? key,
      companyName: await settings.getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en'),
      generatedBy: actor.name,
    };

    await audit.record({
      action: 'EXPORT',
      module: 'reports',
      entityType: 'Report',
      entityId: key,
      summaryEn: `Exported report "${key}" as ${query.format.toUpperCase()} (${report.rows.length} rows)`,
      summaryAr: `تصدير تقرير "${key}" بصيغة ${query.format.toUpperCase()} (${report.rows.length} صف)`,
      actor,
      metadata: {
        format: query.format,
        rows: report.rows.length,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
    });

    if (query.format === 'csv') {
      return new Response(toCsv(report, context), {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${exportFilename(key, 'csv')}"`,
        },
      });
    }

    const buffer = await toExcel(report, context);
    return new Response(new Uint8Array(buffer), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${exportFilename(key, 'xlsx')}"`,
      },
    });
  },
});
