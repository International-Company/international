import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as drawers from '@/modules/drawers/drawer.service';

export const GET = route({
  permissions: ['exchange.drawer.view'],
  handler: async () => {
    const [rows, check] = await Promise.all([drawers.listDrawers(), drawers.verifyBalances()]);
    const derived = new Map(check.drawers.map((entry) => [`${entry.currency}:${entry.kind}`, entry]));

    return rows.map((drawer) => ({
      ...drawer,
      // Surfaced rather than logged quietly: a drawer that disagrees with its
      // own movements is the one thing here nobody should have to go looking for.
      agrees: derived.get(`${drawer.currencyCode}:${drawer.kind}`)?.agrees ?? true,
    }));
  },
});

const bodySchema = z.object({
  currency: z.string().min(2).max(8),
  kind: z.enum(drawers.DRAWER_KINDS).default('CASH'),
  direction: z.enum(['IN', 'OUT']),
  amount: z.string(),
  note: z.string().max(500).optional(),
});

/**
 * Putting money in a drawer, or taking it out.
 *
 * The only way money enters or leaves the branch without a customer on the other
 * side of it, which is why it needs its own permission and its own audit line
 * rather than being one more kind of transaction.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.drawer.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const balance = await drawers.fund(
      {
        currency: body.currency.toUpperCase(),
        kind: body.kind,
        direction: body.direction,
        amount: parseMoney(body.amount),
        note: body.note ?? null,
      },
      actor,
    );

    return { currency: body.currency.toUpperCase(), kind: body.kind, balance };
  },
});

/**
 * Editing a drawer — its name, its warning threshold, whether it is open.
 *
 * Deliberately no balance field. A balance is the sum of the movements under it;
 * setting it directly would leave the drawer disagreeing with its own history.
 * Money moves through POST, which records why.
 */
const createSchema = z.object({
  currency: z.string().min(2).max(8),
  kind: z.enum(drawers.DRAWER_KINDS),
  nameEn: z.string().min(1).max(80),
  nameAr: z.string().min(1).max(80),
  lowBalanceThreshold: z.string().optional(),
  allowNegative: z.boolean().optional(),
});

/** Opens a drawer for a currency and kind that has none. */
export const PUT = route<z.infer<typeof createSchema>>({
  permissions: ['exchange.drawer.manage'],
  bodySchema: createSchema,
  handler: async ({ body, actor }) => {
    const drawer = await drawers.createDrawer(
      {
        currency: body.currency.toUpperCase(),
        kind: body.kind,
        nameEn: body.nameEn,
        nameAr: body.nameAr,
        lowBalanceThreshold: body.lowBalanceThreshold
          ? parseMoney(body.lowBalanceThreshold)
          : undefined,
        allowNegative: body.allowNegative,
      },
      actor,
    );

    return { currency: drawer.currencyCode, kind: drawer.kind };
  },
});

const removeSchema = z.object({
  currency: z.string().min(2).max(8),
  kind: z.enum(drawers.DRAWER_KINDS),
});

/**
 * Removes a drawer that was never used.
 *
 * The service decides what "never used" means and refuses everything else — a
 * drawer with movements is closed, not deleted, because its movements explain
 * balances that have already been reported.
 */
export const DELETE = route<unknown, z.infer<typeof removeSchema>>({
  permissions: ['exchange.drawer.manage'],
  querySchema: removeSchema,
  handler: async ({ query, actor }) => {
    await drawers.deleteDrawer(query.currency.toUpperCase(), query.kind, actor);
    return { ok: true };
  },
});

const patchSchema = z.object({
  currency: z.string().min(2).max(8),
  kind: z.enum(drawers.DRAWER_KINDS).default('CASH'),
  nameEn: z.string().min(1).max(80).optional(),
  nameAr: z.string().min(1).max(80).optional(),
  lowBalanceThreshold: z.string().optional(),
  allowNegative: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const PATCH = route<z.infer<typeof patchSchema>>({
  permissions: ['exchange.drawer.manage'],
  bodySchema: patchSchema,
  handler: async ({ body, actor }) => {
    const updated = await drawers.updateDrawer(
      body.currency.toUpperCase(),
      body.kind,
      {
        nameEn: body.nameEn,
        nameAr: body.nameAr,
        lowBalanceThreshold:
          body.lowBalanceThreshold !== undefined
            ? parseMoney(body.lowBalanceThreshold || '0')
            : undefined,
        allowNegative: body.allowNegative,
        isActive: body.isActive,
      },
      actor,
    );

    return { currency: updated.currencyCode, kind: updated.kind };
  },
});
