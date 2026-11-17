import { z } from 'zod';
import { route } from '@/core/http/route';
import { feedGroups, setWatched } from '@/modules/bank/group-feed.service';

const DESK = ['bank.execute', 'exchange.transfer.confirm'];

/** The groups the bank desk follows, for its tabs. */
export const GET = route({
  anyPermission: DESK,
  handler: async ({ actor }) => feedGroups(actor),
});

const bodySchema = z.object({
  groups: z
    .array(z.object({ id: z.string().min(5).max(80), name: z.string().max(120) }))
    .max(10),
});

/** The office chooses which groups the desk follows. */
export const PUT = route<z.infer<typeof bodySchema>>({
  permissions: ['settings.manage'],
  bodySchema,
  handler: async ({ body, actor }) => setWatched(body.groups, actor),
});
