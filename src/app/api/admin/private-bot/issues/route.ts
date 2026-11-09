import { route } from '@/core/http/route';
import { dismissAll, listIssues } from '@/modules/whatsapp/bot-issues';

export const GET = route({
  permissions: ['settings.view'],
  handler: async () => listIssues(),
});

export const DELETE = route({
  permissions: ['settings.view'],
  handler: async () => {
    await dismissAll();
    return { ok: true };
  },
});
