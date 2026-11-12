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
   * mistaken for the other on the wire. Sending, the second can come later.
   */
  gross: z.string(),
  net: z.string().nullish(),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  notes: z.string().max(1000).nullish(),
  /** Sending: what reaches the beneficiary and in what, for showing only. */
  delivered: z.string().nullish(),
  deliveredUnit: z.string().max(20).nullish(),
  /** Sending: the customer paid by transfer, into this account. Otherwise notes. */
  intakeChannel: z.string().max(80).nullish(),
  /** Sending, paid both ways: the part that came by transfer; the rest was notes. */
  intakeTransfer: z.string().nullish(),
  /** A photo of what the customer paid, shrunk by the screen, as base64. */
  proof: z.string().max(6_000_000).nullish(),
  /** A photo of who the remittance is for, the same way. */
  beneficiary: z.string().max(6_000_000).nullish(),
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

    const net = parseMoney(body.net ?? '0');

    if (body.direction === 'OUT') {
      return remittances.send(
        {
          ...common,
          collected: parseMoney(body.gross),
          cost: net > 0n ? net : null,
          deliveredAmount: body.delivered ? parseMoney(body.delivered) : null,
          deliveredUnit: body.deliveredUnit ?? null,
          intakeChannel: body.intakeChannel ?? null,
          intakeTransfer: body.intakeTransfer ? parseMoney(body.intakeTransfer) : null,
          proof: body.proof ?? null,
          beneficiary: body.beneficiary ?? null,
        },
        actor,
      );
    }

    return remittances.receive(
      { ...common, credited: parseMoney(body.gross), paid: net },
      actor,
    );
  },
});
