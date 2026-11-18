import { z } from 'zod';
import { route } from '@/core/http/route';
import { executorsFor, setExecutors } from '@/modules/bank/group-feed.service';

/** The groups that carry the transfers out, offered first when one is passed on. */
export const GET = route({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  handler: async ({ actor }) => executorsFor(actor),
});

const bodySchema = z.object({
  groups: z
    .array(z.object({ id: z.string().min(5).max(80), name: z.string().max(120) }))
    .max(20),
});

/** Whoever works the desk pins them, or the manager. */
export const PUT = route<z.infer<typeof bodySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm', 'settings.manage'],
  bodySchema,
  handler: async ({ body, actor }) => setExecutors(body.groups, actor),
});
