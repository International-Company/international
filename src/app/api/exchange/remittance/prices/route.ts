import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as prices from '@/modules/exchange/remittance-prices.service';
import { FEE_KINDS } from '@/modules/exchange/remittance-pricing';

/** The price list, changed from the remittance screen. The service checks who may. */
const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    destination: z.string().min(1).max(120),
    currency: z.string().min(2).max(8),
    chargeKind: z.enum(FEE_KINDS),
    chargeValue: z.string().min(1).max(30),
    costKind: z.enum(FEE_KINDS),
    costValue: z.string().min(1).max(30),
  }),
  z.object({ action: z.literal('delete'), id: z.string().min(1) }),
]);

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['exchange.remittance.use'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (body.action === 'delete') return prices.deletePrice(body.id, actor);
    return prices.savePrice(
      {
        destination: body.destination,
        currency: body.currency.toUpperCase(),
        chargeKind: body.chargeKind,
        chargeValue: parseMoney(body.chargeValue),
        costKind: body.costKind,
        costValue: parseMoney(body.costValue),
      },
      actor,
    );
  },
});
