import { z } from 'zod';
import { route } from '@/core/http/route';
import * as settings from '@/modules/settings/settings.service';
import {
  FORWARD_KINDS,
  MAX_FORWARD_RULES,
  parseForwardRules,
} from '@/modules/whatsapp/group-forward';

/** The rules for passing messages from one group on to another. */
export const GET = route({
  permissions: ['settings.view'],
  handler: async () => parseForwardRules(await settings.getString('whatsapp.forwardRules')),
});

const groupSchema = z.object({ id: z.string().trim().min(1).max(120), name: z.string().max(200) });

const bodySchema = z.object({
  rules: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        enabled: z.boolean(),
        from: groupSchema,
        to: groupSchema,
        words: z.string().max(2000),
        senders: z.string().max(2000),
        kind: z.enum(FORWARD_KINDS),
      }),
    )
    .max(MAX_FORWARD_RULES),
});

/** All the rules at once, as the panel holds them. */
export const PUT = route<z.infer<typeof bodySchema>>({
  permissions: ['settings.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const rules = parseForwardRules(JSON.stringify(body.rules));
    await settings.setMany({ 'whatsapp.forwardRules': JSON.stringify(rules) }, actor);
    return rules;
  },
});
