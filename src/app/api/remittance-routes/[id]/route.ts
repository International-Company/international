import { z } from 'zod';
import { route } from '@/core/http/route';
import { deleteRoute, ROUTE_DIRECTIONS, updateRoute } from '@/modules/whatsapp/remittance-routes.service';

const paramsSchema = z.object({ id: z.string().min(1) });

const bodySchema = z.object({
  country: z.string().trim().min(1).max(80),
  network: z.string().trim().max(40).nullish(),
  direction: z.enum(ROUTE_DIRECTIONS).default('BOTH'),
  groupChat: z.string().min(5).max(120),
  groupName: z.string().max(120).nullish(),
});

export const PATCH = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp.monitor'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) =>
    updateRoute(params.id, { ...body, network: body.network ?? null, groupName: body.groupName ?? null }, actor.name),
});

export const DELETE = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['customers.whatsapp.monitor'],
  paramsSchema,
  handler: async ({ params }) => deleteRoute(params.id),
});
