import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as wallet from '@/modules/exchange/wallet-ops.service';

const bodySchema = z.object({
  op: z.enum(wallet.WALLET_OPS),
  currency: z.string().min(2).max(8),
  /** What moves through the wallet — the figure on the customer's phone. */
  amount: z.string(),
  /** What the office keeps. */
  fee: z.string().default('0'),
  channel: z.string().min(1).max(80),
  account: z.string().max(80).nullish(),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  notes: z.string().max(1000).nullish(),
});

/**
 * A wallet cash-out or top-up, on the machine's permissions: it is the same
 * counter, the same teller and the same account as an exchange.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.machine.use', 'exchange.transaction.create'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    return wallet.recordWalletOp(
      {
        op: body.op,
        currency: body.currency.toUpperCase(),
        amount: parseMoney(body.amount),
        fee: parseMoney(body.fee || '0'),
        channel: body.channel,
        account: body.account ?? null,
        branchId: actor.branchId,
        customerId: body.customerId ?? null,
        counterpartyName: body.counterpartyName ?? null,
        counterpartyPhone: body.counterpartyPhone ?? null,
        notes: body.notes ?? null,
      },
      actor,
    );
  },
});
