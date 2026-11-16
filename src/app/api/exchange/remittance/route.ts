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
  /** Through the office's PayPal account: no destination, in dollars. */
  paypal: z.boolean().optional(),
  /** PayPal received: the money it is paid out in, when not dollars. */
  payCurrency: z.string().min(2).max(8).nullish(),
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
  /** Receiving: a photo of the notice of the transfer from abroad, the same way. */
  notice: z.string().max(6_000_000).nullish(),
  /** Receiving: who collects it here. The counterparty is who sent it. */
  recipientName: z.string().max(200).nullish(),
  recipientPhone: z.string().max(40).nullish(),
  recipientIdNumber: z.string().max(40).nullish(),
  /** Receiving: the part paid by transfer, where to, and the account there. */
  payoutBank: z.string().nullish(),
  payoutChannel: z.string().max(80).nullish(),
  payoutAccount: z.string().max(80).nullish(),
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.remittance.use', 'exchange.transaction.create'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    const common = {
      currency: body.currency.toUpperCase(),
      destination: body.paypal ? remittances.PAYPAL_DESTINATION : body.destination,
      paypal: body.paypal ?? false,
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
      {
        ...common,
        credited: parseMoney(body.gross),
        paid: net,
        payCurrency: body.paypal ? (body.payCurrency ?? null) : null,
        // What the sender paid abroad, in what they paid it — 1500 جنيه.
        sentAmount: body.delivered ? parseMoney(body.delivered) : null,
        sentUnit: body.deliveredUnit ?? null,
        notice: body.notice ?? null,
        recipientName: body.recipientName ?? null,
        recipientPhone: body.recipientPhone ?? null,
        recipientIdNumber: body.recipientIdNumber ?? null,
        payoutBank: body.payoutBank ? parseMoney(body.payoutBank) : null,
        payoutChannel: body.payoutChannel ?? null,
        payoutAccount: body.payoutAccount ?? null,
      },
      actor,
    );
  },
});
