import { z } from 'zod';
import { route } from '@/core/http/route';
import * as settings from '@/modules/settings/settings.service';
import { HIDDEN_MENUS_SETTING, hiddenMenus } from '@/modules/bank/bank-desk';

const WHO = ['treasury.supervise', 'settings.manage'];

/** The menus hidden from the tellers, by where they lead. */
export const GET = route({
  anyPermission: WHO,
  handler: async () => ({ hidden: await hiddenMenus() }),
});

const bodySchema = z.object({
  hidden: z.array(z.string().startsWith('/').max(120)).max(60),
});

/** The tellers' supervisor, or a manager, hides menus from the tellers. */
export const PUT = route<z.infer<typeof bodySchema>>({
  anyPermission: WHO,
  bodySchema,
  handler: async ({ body, actor }) => {
    const hidden = [...new Set(body.hidden)];
    await settings.set(HIDDEN_MENUS_SETTING, hidden, actor);
    return { hidden };
  },
});
