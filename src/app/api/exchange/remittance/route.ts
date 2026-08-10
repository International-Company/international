import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as remittances from '@/modules/exchange/remittance.service';

/**
 * Remittances at the counter.
 *
 * One endpoint for both directions, because they are the same transaction seen
 * from either end: two figures in one currency, and the gap between them is
 * what the branch earns. Splitting them into two routes would duplicate the
 * destination check and the customer rules for no gain.
 */

const bodySchema = z.object({
  direction: z.enum(['OUT', 'IN']),
  currency: z.string().min(2).max(8),
  destination: z.string().min(1).max(120),
  /**
   * Sending: what the customer hands over, then what the correspondent charges.
   * Receiving: what the correspondent credits, then what the customer is paid.
   *
   * Named for the roles rather than the direction so neither reading can be
   * mistaken for the other on the wire.
   */
  gross: z.string(),
  net: z.string(),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  notes: z.string().max(1000).nullish(),
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.remittance.use', 'exchange.transaction.create'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    const common = {
      currency: body.currency.toUpperCase(),
      destination: body.destination,
      branchId: actor.branchId,
      customerId: body.customerId ?? null,
      counterpartyName: body.counterpartyName ?? null,
      counterpartyPhone: body.counterpartyPhone ?? null,
      notes: body.notes ?? null,
    };

    if (body.direction === 'OUT') {
      return remittances.send(
        { ...common, collected: parseMoney(body.gross), cost: parseMoney(body.net) },
        actor,
      );
    }

    return remittances.receive(
      { ...common, credited: parseMoney(body.gross), paid: parseMoney(body.net) },
      actor,
    );
  },
});
