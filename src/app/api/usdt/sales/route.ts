import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as sales from '@/modules/usdt/sale.service';

const bodySchema = z.object({
  currency: z.string().min(2).max(8),
  /** The coins sold. */
  usdt: z.string(),
  /** What the customer paid per coin. */
  price: z.string(),
  mode: z.enum(sales.SALE_MODES).default('CASH'),
  intakeChannel: z.string().max(80).nullish(),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  notes: z.string().max(1000).nullish(),
});

/** A USDT sale the teller made and sent himself — recorded, nothing sent. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['usdt.withdrawal.use', 'exchange.transaction.create'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    return sales.recordSale(
      {
        payCurrency: body.currency.toUpperCase(),
        usdtAmount: parseMoney(body.usdt),
        price: parseMoney(body.price),
        mode: body.mode,
        intakeChannel: body.intakeChannel ?? null,
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
