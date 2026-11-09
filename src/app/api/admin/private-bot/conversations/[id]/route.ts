import { z } from 'zod';
import { route } from '@/core/http/route';
import { readConversation, setPaused } from '@/modules/whatsapp/bot-store';

const paramsSchema = z.object({ id: z.string().min(1) });

export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['settings.view'],
  paramsSchema,
  handler: async ({ params }) => readConversation(params.id),
});

const bodySchema = z.object({
  /** How long the bot keeps out of it; null hands it back at once. */
  pauseMinutes: z.number().int().min(1).max(10080).nullable(),
});

export const PATCH = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['settings.view'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body }) => {
    await setPaused(params.id, body.pauseMinutes);
    return readConversation(params.id);
  },
});
