import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import * as day from '@/modules/exchange/business-day.service';

/** Today's day, and the recent ones, for the manager's panel. */
export const GET = route({
  permissions: ['exchange.day.view'],
  handler: async ({ actor }) => {
    const branchId = await requireBranch(actor.branchId);
    const [current, recent] = await Promise.all([
      day.getCurrentDay(branchId),
      day.listDays(branchId, 14),
    ]);
    return { current, recent };
  },
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), notes: z.string().max(500).optional() }),
  z.object({ action: z.literal('close'), notes: z.string().max(500).optional() }),
  z.object({ action: z.literal('reopen'), reason: z.string().min(3).max(500) }),
]);

/**
 * Opening and closing the counter's day.
 *
 * The teller cannot do this. Nothing can be recorded until the manager opens the
 * day and nothing more can be recorded once they close it, which is what makes a
 * day a reviewable unit rather than an arbitrary slice of the clock.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.day.open'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const branchId = await requireBranch(actor.branchId);

    switch (body.action) {
      case 'open':
        return day.openDay(branchId, actor, { notes: body.notes });

      case 'close':
        if (!actor.permissions.includes('exchange.day.close')) {
          throw errors.forbidden('exchange.day.close');
        }
        return day.closeDay(branchId, actor, { notes: body.notes });

      case 'reopen':
        if (!actor.permissions.includes('exchange.day.reopen')) {
          throw errors.forbidden('exchange.day.reopen');
        }
        return day.reopenDay(branchId, actor, { reason: body.reason });
    }
  },
});

/** A single-branch product; the branch is whichever one exists. */
async function requireBranch(branchId: string | null): Promise<string> {
  if (branchId) return branchId;

  const { prisma } = await import('@/core/db/prisma');
  const branch = await prisma.branch.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } });
  if (!branch) throw errors.precondition('No branch is configured', 'errors.noBranch');
  return branch.id;
}
