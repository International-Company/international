import { z } from 'zod';
import { route } from '@/core/http/route';
import { archive, inbox, markAllRead, markRead, unreadSummary } from '@/modules/notifications/notifications.service';

const querySchema = z.object({
  severity: z.enum(['CRITICAL', 'WARNING', 'INFO', 'SUCCESS']).optional(),
  module: z.string().optional(),
  unreadOnly: z.coerce.boolean().default(false),
  includeArchived: z.coerce.boolean().default(false),
  search: z.string().optional(),
  summaryOnly: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['notifications.view'],
  querySchema,
  handler: async ({ query, session }) => {
    // The shell polls only for the badge; skip the full listing for that.
    if (query.summaryOnly) return unreadSummary(session.user.id);

    return inbox({ ...query, userId: session.user.id });
  },
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), ids: z.array(z.string()).min(1) }),
  z.object({ action: z.literal('readAll') }),
  z.object({ action: z.literal('archive'), ids: z.array(z.string()).min(1) }),
]);

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['notifications.view'],
  bodySchema,
  handler: async ({ body, session }) => {
    if (body.action === 'read') {
      return { updated: await markRead(body.ids, session.user.id) };
    }
    if (body.action === 'readAll') {
      return { updated: await markAllRead(session.user.id) };
    }
    return { updated: await archive(body.ids, session.user.id) };
  },
});
