import { z } from 'zod';
import { route } from '@/core/http/route';
import { feed } from '@/modules/bank/group-feed.service';

const querySchema = z.object({ chat: z.string().min(5).max(80) });

/** A followed group's latest messages, each with its deal and where it was passed on. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  querySchema,
  handler: async ({ query, actor }) => feed(query.chat, actor),
});
