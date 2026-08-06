import { z } from 'zod';
import { route } from '@/core/http/route';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as businessDay from '@/modules/exchange/business-day.service';

const querySchema = z.object({
  branchId: z.string().optional(),
  view: z.enum(['current', 'sheet', 'history']).default('current'),
  date: z.coerce.date().optional(),
});

async function resolveBranch(branchId?: string | null): Promise<string> {
  const resolved =
    branchId ??
    (await prisma.branch.findFirst({ where: { isActive: true }, orderBy: { code: 'asc' } }))?.id;

  if (!resolved) throw errors.precondition('No active branch is configured', 'errors.noBranch');
  return resolved;
}

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.day.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    const branchId = await resolveBranch(query.branchId ?? actor.branchId);

    if (query.view === 'history') {
      return businessDay.listDays(branchId);
    }
    if (query.view === 'sheet') {
      return businessDay.closingSheet(branchId, query.date ?? new Date());
    }

    return {
      day: await businessDay.getCurrentDay(branchId),
      branchId,
    };
  },
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('open'),
    branchId: z.string().optional(),
    date: z.coerce.date().optional(),
    notes: z.string().max(1000).optional(),
  }),
  z.object({
    action: z.literal('close'),
    branchId: z.string().optional(),
    date: z.coerce.date().optional(),
    notes: z.string().max(1000).optional(),
    counts: z
      .array(
        z.object({
          accountId: z.string(),
          countedBalance: z.string().or(z.number()),
          note: z.string().max(300).optional(),
        }),
      )
      .default([]),
  }),
  z.object({
    action: z.literal('reopen'),
    businessDayId: z.string(),
    reason: z.string().min(3).max(500),
  }),
]);

export const POST = route<z.infer<typeof bodySchema>>({
  bodySchema,
  handler: async ({ body, actor }) => {
    const require = (permission: string) => {
      if (!actor.permissions.includes(permission)) throw errors.forbidden(permission);
    };

    if (body.action === 'open') {
      require('exchange.day.open');
      const branchId = await resolveBranch(body.branchId ?? actor.branchId);
      return businessDay.openDay(branchId, actor, { date: body.date, notes: body.notes });
    }

    if (body.action === 'close') {
      require('exchange.day.close');
      const branchId = await resolveBranch(body.branchId ?? actor.branchId);

      return businessDay.closeDay(
        branchId,
        body.counts.map((count) => ({
          accountId: count.accountId,
          countedBalance: parseMoney(count.countedBalance),
          note: count.note,
        })),
        actor,
        { date: body.date, notes: body.notes },
      );
    }

    require('exchange.day.reopen');
    await businessDay.reopenDay(body.businessDayId, body.reason, actor);
    return { ok: true };
  },
});
