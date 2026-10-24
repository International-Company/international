import { z } from 'zod';
import { route } from '@/core/http/route';
import { LOCALES } from '@/i18n/config';
import * as share from '@/modules/exchange/share.service';

const querySchema = z.object({
  locale: z.enum(LOCALES).optional(),
  /** Exchange and USDT are settled apart; each screen asks for its own. */
  kind: z.enum(['exchange', 'usdt']).optional(),
});

/**
 * Every transfer still owed, written as one message — four lines each, in the
 * office's order — for the person who makes the transfers.
 *
 * Behind the receipt permission, like a single share: it is the same lines the
 * receipts already carry, gathered. A teller gets their own; someone who sees
 * everybody's transactions gets the office's.
 */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['exchange.receipt.print'],
  querySchema,
  handler: async ({ query, actor }) => share.pendingTransfers(actor, query.locale ?? 'ar', undefined, query.kind),
});
