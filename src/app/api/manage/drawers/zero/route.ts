import { z } from 'zod';
import { route } from '@/core/http/route';
import * as drawers from '@/modules/drawers/drawer.service';

/**
 * Which drawers cannot be zeroed right now, and why — so the screen can show
 * them locked before the manager tries, rather than after.
 */
export const GET = route({
  permissions: ['exchange.drawer.manage'],
  handler: async () => {
    const locks = await drawers.zeroLocks();
    return {
      locked: [...locks].map(([drawerId, reason]) => ({ drawerId, reason })),
    };
  },
});

const bodySchema = z.object({
  reason: z.string().min(3).max(500),
  /** The drawers the manager ticked. Named, never "all except". */
  drawerIds: z.array(z.string().min(1)).min(1).max(500),
});

/**
 * Brings the chosen drawers back to zero, each with a movement that says so.
 *
 * The service checks the permission and the conditions itself — an open day,
 * and none of the chosen drawers locked by a shift or a handover — rather than
 * trusting this route to be the only way in.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.drawer.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const { zeroed } = await drawers.zeroAll(
      { reason: body.reason, drawerIds: body.drawerIds },
      actor,
    );
    return {
      count: zeroed.length,
      zeroed: zeroed.map((entry) => ({ ...entry, was: entry.was.toString() })),
    };
  },
});
