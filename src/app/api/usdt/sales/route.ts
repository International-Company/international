import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import { parseMoney } from '@/core/money/money';
import * as sales from '@/modules/usdt/sale.service';

const bodySchema = z.object({
  currency: z.string().min(2).max(8),
  /** The coins sold, or what was received for them: whichever the teller typed. */
  usdt: z.string().nullish(),
  received: z.string().nullish(),
  /** What the customer paid per coin; for dollars, the percentage kept instead. */
  price: z.string().nullish(),
  percent: z.string().nullish(),
  mode: z.enum(sales.SALE_MODES).default('CASH'),
  intakeChannel: z.string().max(80).nullish(),
  customerId: z.string().nullish(),
  counterpartyName: z.string().max(200).nullish(),
  counterpartyPhone: z.string().max(40).nullish(),
  notes: z.string().max(1000).nullish(),
  /** Photos shrunk by the screen, as base64. The service checks what they are. */
  transferPhoto: z.string().max(6_000_000).nullish(),
  addressPhoto: z.string().max(6_000_000).nullish(),
  address: z.string().max(300).nullish(),
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
        usdtAmount: body.usdt ? parseMoney(body.usdt) : null,
        received: body.received ? parseMoney(body.received) : null,
        price: body.price ? parseMoney(body.price) : null,
        percent: body.percent ? parseMoney(body.percent) : null,
        mode: body.mode,
        intakeChannel: body.intakeChannel ?? null,
        branchId: actor.branchId,
        customerId: body.customerId ?? null,
        counterpartyName: body.counterpartyName ?? null,
        counterpartyPhone: body.counterpartyPhone ?? null,
        notes: body.notes ?? null,
        transferPhoto: body.transferPhoto ?? null,
        addressPhoto: body.addressPhoto ?? null,
        address: body.address ?? null,
      },
      actor,
    );
  },
});
