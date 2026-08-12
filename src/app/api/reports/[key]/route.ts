import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { prisma } from '@/core/db/prisma';
import { resolveLocale } from '@/i18n/config';
import * as reports from '@/modules/reports/report.service';

/**
 * One report, as figures or as a spreadsheet.
 *
 * The permission is the report's own — declared on its definition rather than
 * on this route, because "may run a report" is not one right: the man who may
 * read the transactions is not necessarily the man who may read what each
 * teller gave the office.
 */

const paramsSchema = z.object({ key: z.string().min(1) });
const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  tellerId: z.string().optional(),
  format: z.enum(['json', 'xlsx']).default('json'),
  locale: z.string().optional(),
});

/** A day boundary from `YYYY-MM-DD`, read as local midnight. */
function parseDay(value: string | undefined, fallback: Date, endOfDay = false): Date {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fallback;
  const [year, month, day] = value.split('-').map(Number);
  return endOfDay
    ? new Date(year!, month! - 1, day!, 23, 59, 59, 999)
    : new Date(year!, month! - 1, day!);
}

export const GET = route<unknown, z.infer<typeof querySchema>, z.infer<typeof paramsSchema>>({
  paramsSchema,
  querySchema,
  handler: async ({ params, query, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    const now = new Date();
    const to = parseDay(query.to, now, true);
    // A month back by default, which is the span a manager talks in.
    const from = parseDay(query.from, new Date(to.getTime() - 30 * 86_400_000));

    const ran = await reports.run(
      params.key,
      { branchId: actor.branchId, from, to, tellerId: query.tellerId },
      actor,
    );

    if (query.format === 'xlsx') {
      const locale = resolveLocale(query.locale);
      const currencies = await prisma.currency.findMany({ select: { code: true, decimals: true } });

      const workbook = await reports.toWorkbook(
        ran,
        locale,
        new Map(currencies.map((currency) => [currency.code, currency.decimals])),
      );

      // Taking the office's figures somewhere the system can no longer see them
      // is worth writing down.
      await reports.recordExport(ran, 'xlsx', actor);

      const stamp = ran.from.slice(0, 10);
      return new Response(new Uint8Array(workbook), {
        headers: {
          'content-type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-disposition': `attachment; filename="${ran.key}-${stamp}.xlsx"`,
          'cache-control': 'no-store',
        },
      });
    }

    /*
     * Money leaves as a string. It is a `bigint` here and JSON has no such
     * thing — turning it into a double on the way out is how a figure arrives
     * at a screen one agura short of what the database holds.
     */
    return {
      key: ran.key,
      nameEn: ran.nameEn,
      nameAr: ran.nameAr,
      columns: ran.columns,
      from: ran.from,
      to: ran.to,
      count: ran.count,
      rows: ran.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([field, value]) => [
            field,
            typeof value === 'bigint'
              ? value.toString()
              : value instanceof Date
                ? value.toISOString()
                : value,
          ]),
        ),
      ),
    };
  },
});
