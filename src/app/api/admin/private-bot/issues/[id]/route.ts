import { z } from 'zod';
import { route } from '@/core/http/route';
import { dismissIssue } from '@/modules/whatsapp/bot-issues';

const paramsSchema = z.object({ id: z.string().min(1) });

export const DELETE = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['settings.view'],
  paramsSchema,
  handler: async ({ params }) => {
    await dismissIssue(params.id);
    return { ok: true };
  },
});
