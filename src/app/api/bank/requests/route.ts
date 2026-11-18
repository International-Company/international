import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { addByHand } from '@/modules/bank/bank-request.service';

const bodySchema = z.object({
  /** The followed group's message it was asked in. */
  messageId: z.string().min(1),
  account: z.string().min(1).max(60),
  name: z.string().max(120).nullish(),
  channel: z.string().max(80).nullish(),
  amount: z.string().min(1).max(30),
  currency: z.string().min(3).max(8).default('ILS'),
});

/** A group's message the bot could not read, added to the desk's list by a person. */
export const POST = route<z.infer<typeof bodySchema>>({
  anyPermission: ['bank.execute', 'exchange.transfer.confirm'],
  bodySchema,
  handler: async ({ body, actor }) =>
    addByHand(
      body.messageId,
      {
        account: body.account,
        name: body.name ?? null,
        channel: body.channel ?? null,
        amount: parseMoney(body.amount),
        currency: body.currency.toUpperCase(),
      },
      actor,
    ),
});
