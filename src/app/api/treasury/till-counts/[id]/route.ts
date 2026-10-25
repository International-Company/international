import { z } from 'zod';
import { route } from '@/core/http/route';
import * as tills from '@/modules/treasury/till-count.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/** One till count in full: for the teller it is about, or anyone who counts. */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  paramsSchema,
  handler: async ({ params, actor }) => {
    const count = await tills.getCount(params.id, actor);
    return {
      id: count.id,
      reference: count.reference,
      teller: count.teller,
      countedBy: count.countedBy,
      note: count.note,
      periodStart: count.periodStart.toISOString(),
      periodEnd: count.periodEnd.toISOString(),
      createdAt: count.createdAt.toISOString(),
      lines: count.lines.map((line) => ({
        currency: line.currencyCode,
        opening: line.opening.toString(),
        received: line.received.toString(),
        paid: line.paid.toString(),
        toppedUp: line.toppedUp.toString(),
        drawn: line.drawn.toString(),
        expected: line.expected.toString(),
        counted: line.counted.toString(),
        difference: line.difference.toString(),
        kept: line.kept.toString(),
      })),
    };
  },
});
