import { z } from 'zod';
import { route } from '@/core/http/route';
import { REQUEST_STATUSES, setRequestStatus } from '@/modules/whatsapp/bot-store';

const paramsSchema = z.object({ id: z.string().min(1) });
const bodySchema = z.object({ status: z.enum(REQUEST_STATUSES) });

export const PATCH = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['settings.view'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => {
    await setRequestStatus(params.id, body.status, actor);
    return { ok: true };
  },
});
