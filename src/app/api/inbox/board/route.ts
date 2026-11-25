import { z } from 'zod';
import { route } from '@/core/http/route';
import { toJsonSafe } from '@/core/http/json';
import { remittanceBoard } from '@/modules/whatsapp/remittance-board.service';
import { tellCustomerByHand } from '@/modules/whatsapp/remittance-notice.service';

/** The days asked for, as the browser's own midnight to midnight; none, today. */
const querySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** The manager's choice of one teller. */
  owner: z.string().max(40).optional(),
});

/** The remittances taken from WhatsApp, each followed from notice to money paid. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['customers.whatsapp'],
  querySchema,
  handler: async ({ actor, query }) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return toJsonSafe(
      await remittanceBoard(
        { id: actor.id, all: actor.permissions.includes('customers.whatsapp.monitor') },
        { from: query.from ? new Date(query.from) : today, to: query.to ? new Date(query.to) : new Date() },
        { owner: query.owner ?? null },
      ),
    );
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
