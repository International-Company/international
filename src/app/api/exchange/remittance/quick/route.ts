import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as remittances from '@/modules/exchange/remittance.service';

const bodySchema = z.object({
  currency: z.string().min(2).max(8),
  /** The notes taken for remittances, then what the correspondent charges for them. */
  received: z.string(),
  cost: z.string(),
  notes: z.string().max(1000).nullish(),
});

/** Only writing down what was taken for remittances, as the teller typed it. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.remittance.use', 'exchange.transaction.create'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');
    return remittances.recordCash(
      {
        currency: body.currency.toUpperCase(),
        branchId: actor.branchId,
        collected: parseMoney(body.received),
        cost: parseMoney(body.cost),
        notes: body.notes ?? null,
      },
      actor,
    );
  },
});
