import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as shifts from '@/modules/treasury/shift.service';
import * as differences from '@/modules/treasury/discrepancy.service';

/**
 * The differences balance, over HTTP.
 *
 * Reading it needs only the right to see the office's position; ruling on one is
 * the manager's, and the service enforces that rather than the door — the same
 * decision made in two places eventually disagrees with itself.
 */

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('resolve'),
    id: z.string().min(1),
    resolution: z.enum(differences.RESOLUTIONS),
    note: z.string().max(500).nullish(),
  }),
  z.object({
    action: z.literal('settle'),
    tellerId: z.string().min(1),
    currency: z.string().min(2).max(8),
    amount: z.string(),
    note: z.string().max(500).nullish(),
  }),
]);

export const GET = route({
  permissions: ['ledger.view'],
  handler: async () => {
    const [open, debts, oldest, recent] = await Promise.all([
      shifts.openDiscrepancies(),
      differences.outstandingDebts(),
      shifts.oldestOpenAgeDays(),
      shifts.listShifts({ limit: 15 }),
    ]);

    return {
      // Oldest first, and the age with them: a suspense balance is only honest
      // for as long as somebody is still looking at it.
      oldestOpenAgeDays: oldest,
      open: open.map((row) => ({
        id: row.id,
        shift: row.shift?.reference ?? row.tillCount?.reference ?? '',
        tellerId: row.teller.id,
        tellerNameEn: row.teller.fullNameEn,
        tellerNameAr: row.teller.fullNameAr,
        currency: row.currencyCode,
        decimals: row.currency.decimals,
        // Positive is short, negative is over. Kept signed so the screen can say
        // which, rather than inferring it from a label.
        amount: row.amount.toString(),
        createdAt: row.createdAt.toISOString(),
      })),
      debts: debts.map((row) => ({
        tellerId: row.tellerId,
        tellerNameEn: row.teller?.fullNameEn ?? '',
        tellerNameAr: row.teller?.fullNameAr ?? '',
        currency: row.currencyCode,
        amount: row.balance.toString(),
      })),
      shifts: recent.map((row) => ({
        id: row.id,
        reference: row.reference,
        tellerNameEn: row.teller.fullNameEn,
        tellerNameAr: row.teller.fullNameAr,
        status: row.status,
        openedAt: row.openedAt.toISOString(),
        closedAt: row.closedAt?.toISOString() ?? null,
        differences: row.discrepancies.length,
      })),
    };
  },
});

export const POST = route<z.infer<typeof bodySchema>>({
  bodySchema,
  handler: async ({ body, actor }) => {
    if (body.action === 'resolve') {
      await differences.resolve(body.id, { resolution: body.resolution, note: body.note }, actor);
      return { resolved: true };
    }

    return differences.settleDebt(
      {
        tellerId: body.tellerId,
        currency: body.currency.toUpperCase(),
        amount: parseMoney(body.amount),
        note: body.note,
      },
      actor,
    );
  },
});
