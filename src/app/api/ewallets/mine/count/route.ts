import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { submitCount } from '@/modules/treasury/ewallet.service';

const bodySchema = z.object({
  actual: z.string().min(1).max(30),
  /** The screenshot of the wallet's balance, as a data URL or base64. */
  screenshot: z.string().min(10).max(12_000_000),
  note: z.string().max(500).nullish(),
});

/** The teller's count of their wallet: the balance its app shows, with a screenshot. */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['ewallet.use'],
  bodySchema,
  handler: async ({ body, actor }) =>
    submitCount({ actual: parseMoney(body.actual), screenshot: body.screenshot, note: body.note ?? null }, actor),
});
