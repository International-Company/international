import { z } from 'zod';
import { route } from '@/core/http/route';
import { createRoute, listRoutes, ROUTE_DIRECTIONS } from '@/modules/whatsapp/remittance-routes.service';

const routeSchema = z.object({
  country: z.string().trim().min(1).max(80),
  network: z.string().trim().max(40).nullish(),
  direction: z.enum(ROUTE_DIRECTIONS).default('BOTH'),
  groupChat: z.string().min(5).max(120),
  groupName: z.string().max(120).nullish(),
});

/** Every country linked to its agent's group. */
export const GET = route({
  permissions: ['customers.whatsapp.monitor'],
  handler: async () => listRoutes(),
});

/** A country linked to a group. */
export const POST = route<z.infer<typeof routeSchema>>({
  permissions: ['customers.whatsapp.monitor'],
  bodySchema: routeSchema,
  handler: async ({ body, actor }) =>
    createRoute(
      { ...body, network: body.network ?? null, groupName: body.groupName ?? null },
      actor.name,
    ),
});
