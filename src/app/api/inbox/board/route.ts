import { z } from 'zod';
import { route } from '@/core/http/route';
import { toJsonSafe } from '@/core/http/json';
import { remittanceBoard, remittanceBoardStamp } from '@/modules/whatsapp/remittance-board.service';
import { tellCustomerByHand } from '@/modules/whatsapp/remittance-notice.service';

/** The days asked for, as the browser's own midnight to midnight; none, today. */
const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** The manager's choice of one teller. */
  owner: z.string().max(40).optional(),
  /** What the screen last read: unchanged, it is told so, and nothing more is read. */
  stamp: z.string().max(200).optional(),
});

/** The remittances taken from WhatsApp, each followed from notice to money paid. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['customers.whatsapp'],
  querySchema,
  handler: async ({ actor, query }) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const viewer = { id: actor.id, all: actor.permissions.includes('customers.whatsapp.monitor') };
    const range = { from: query.from ? new Date(query.from) : today, to: query.to ? new Date(query.to) : new Date() };
    const options = { owner: query.owner ?? null };
    // Taken first: a change while the board is read shows as a new stamp next time.
    const stamp = await remittanceBoardStamp(viewer, range, options);
    if (query.stamp && query.stamp === stamp) return { same: true, stamp };
    return toJsonSafe({ ...(await remittanceBoard(viewer, range, options)), stamp });
  },
});

const tellSchema = z.object({ action: z.literal('tell'), id: z.string().min(1).max(40) });

/** A remittance already sent: the customer told now, with the bank's receipt, on their own WhatsApp. */
export const POST = route<z.infer<typeof tellSchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema: tellSchema,
  handler: async ({ actor, body }) =>
    tellCustomerByHand(body.id, { id: actor.id, all: actor.permissions.includes('customers.whatsapp.monitor') }),
});
