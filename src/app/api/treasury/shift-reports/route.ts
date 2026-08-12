import { z } from 'zod';
import { route } from '@/core/http/route';
import * as reports from '@/modules/treasury/shift-report.service';

/**
 * The shift reports the system wrote for itself.
 *
 * Read-only, and there is deliberately no endpoint to write one: a report
 * somebody can compose by hand is a report somebody can compose to taste, which
 * is the whole thing this replaces.
 */

const querySchema = z.object({
  tellerId: z.string().optional(),
  limit: z.coerce.number().optional(),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['ledger.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    const rows = await reports.listReports({
      branchId: actor.branchId ?? null,
      tellerId: query.tellerId,
      limit: query.limit,
    });

    return {
      rows: rows.map((row) => ({
        id: row.id,
        shift: row.shift.reference,
        tellerId: row.tellerId,
        tellerNameEn: row.teller.fullNameEn,
        tellerNameAr: row.teller.fullNameAr,
        openedAt: row.openedAt.toISOString(),
        closedAt: row.closedAt.toISOString(),
        minutes: row.minutes,
        base: row.baseCurrency,
        took: row.floatWorth.toString(),
        returned: row.returnedWorth.toString(),
        deals: row.deals,
        dealsByType: row.dealsByType,
        margin: row.margin.toString(),
        differences: row.differences.toString(),
        concessions: row.concessions.toString(),
        net: row.net.toString(),
        exceptionsAsked: row.exceptionsAsked,
        observations: reports.parseObservations(row.observations),
      })),
    };
  },
});
