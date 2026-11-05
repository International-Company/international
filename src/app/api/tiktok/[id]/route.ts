import { z } from 'zod';
import { route } from '@/core/http/route';
import { remove } from '@/modules/tiktok/tiktok.service';

const paramsSchema = z.object({ id: z.string().min(1) });

export const DELETE = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.remittance.use'],
  paramsSchema,
  handler: async ({ params, actor }) => remove(params.id, actor),
});
