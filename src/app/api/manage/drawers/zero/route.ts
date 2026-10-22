import { z } from 'zod';
import { route } from '@/core/http/route';
import * as drawers from '@/modules/drawers/drawer.service';

const bodySchema = z.object({
  reason: z.string().min(3).max(500),
});

/**
 * Brings every drawer back to zero, each with a movement that says so.
 *
 * The service checks the permission and the conditions itself — an open day,
 * no shift open, no handover pending — rather than trusting this route to be
 * the only way in.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.drawer.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const { zeroed } = await drawers.zeroAll({ reason: body.reason }, actor);
    return {
      count: zeroed.length,
      zeroed: zeroed.map((entry) => ({ ...entry, was: entry.was.toString() })),
    };
  },
});
