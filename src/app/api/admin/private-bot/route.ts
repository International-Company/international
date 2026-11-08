import { z } from 'zod';
import { route } from '@/core/http/route';
import { profileSchema, tidyProfile } from '@/modules/whatsapp/bot-profile';
import { botPanel, saveBotPanel, tryBot } from '@/modules/whatsapp/private-bot.service';

/** What the panel shows: what the assistant has been told, and what it can see. */
export const GET = route({
  permissions: ['settings.view'],
  handler: async () => botPanel(),
});

const saveSchema = z.object({
  profile: profileSchema,
  enabled: z.boolean(),
  dailyLimit: z.number().int().min(0).max(5000),
});

export const PUT = route<z.infer<typeof saveSchema>>({
  permissions: ['settings.manage'],
  bodySchema: saveSchema,
  handler: async ({ body, actor }) => {
    await saveBotPanel({ ...body, profile: tidyProfile(body.profile) }, actor);
    return botPanel();
  },
});

const trySchema = z.object({
  turns: z
    .array(
      z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(1200) }),
    )
    .min(1)
    .max(12),
});

/** A question put to the assistant from the panel, as it stands saved. Nothing is sent to WhatsApp. */
export const POST = route<z.infer<typeof trySchema>>({
  permissions: ['settings.manage'],
  bodySchema: trySchema,
  handler: async ({ body }) => tryBot(body.turns),
});
