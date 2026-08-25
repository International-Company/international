import { z } from 'zod';
import { route } from '@/core/http/route';
import * as drawers from '@/modules/drawers/drawer.service';
import * as grants from '@/modules/drawers/grant.service';

/**
 * Delegating a drawer.
 *
 * Reading and writing both sit behind `exchange.drawer.manage` — the manager's
 * permission — because this is the screen that hands out access, and a person
 * who could read it would learn the shape of the treasury he was not given.
 *
 * The service checks the same thing again. Two guards for one rule is
 * deliberate here: this endpoint is how somebody comes to be able to move money
 * without a customer on the other side of it.
 */

const querySchema = z.object({ userId: z.string().min(1).optional() });

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.drawer.manage'],
  querySchema,
  handler: async ({ query, actor }) => {
    if (query.userId) {
      return { grants: await grants.grantsFor(query.userId) };
    }

    // Three halves at once: who already holds something, everyone who could,
    // and every drawer they could be given. The screen needs the drawer list to
    // render a row per drawer whether or not a grant exists for it yet.
    const [holders, all, staff] = await Promise.all([
      grants.delegates(),
      drawers.listDrawers({ includeInactive: false }),
      grants.candidates(actor),
    ]);

    return {
      delegates: holders,
      staff,
      drawers: all
        .filter((drawer) => drawer.ownerKey === drawers.TREASURY)
        .map((drawer) => ({
          id: drawer.id,
          nameAr: drawer.nameAr,
          nameEn: drawer.nameEn,
          kind: drawer.kind,
          currencyCode: drawer.currencyCode,
        })),
    };
  },
});

const bodySchema = z.object({
  userId: z.string().min(1),
  drawerId: z.string().min(1),
  canDeposit: z.boolean().default(false),
  canWithdraw: z.boolean().default(false),
  canTransfer: z.boolean().default(false),
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.drawer.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const flags = await grants.setGrant(body, actor);
    // Null means every box was unticked, which removes the grant entirely — the
    // screen needs to tell those apart to redraw the row.
    return { granted: flags !== null, ...(flags ?? {}) };
  },
});

const deleteSchema = z.object({ userId: z.string().min(1) });

export const DELETE = route<unknown, z.infer<typeof deleteSchema>>({
  permissions: ['exchange.drawer.manage'],
  querySchema: deleteSchema,
  handler: async ({ query, actor }) => {
    const removed = await grants.revokeAll(query.userId, actor);
    return { removed };
  },
});
