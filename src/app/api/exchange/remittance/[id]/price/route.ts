import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { addPrice } from '@/modules/exchange/remittance.service';

const paramsSchema = z.object({ id: z.string().min(1) });
const bodySchema = z.object({ cost: z.string() });

export const POST = route<z.infer<typeof bodySchema>, unknown, z.infer<typeof paramsSchema>>({
  permissions: ['exchange.remittance.use'],
  paramsSchema,
  bodySchema,
  handler: async ({ params, body, actor }) => addPrice(params.id, parseMoney(body.cost), actor),
});
