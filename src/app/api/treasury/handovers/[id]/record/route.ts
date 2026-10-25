import { z } from 'zod';
import { route } from '@/core/http/route';
import * as counts from '@/modules/treasury/count-record.service';

const paramsSchema = z.object({ id: z.string().min(1) });

/**
 * One handover's count record: the books, the declaration and the count, per
 * currency. For the teller it is about, or anyone who counts handovers — the
 * service decides which.
 */
export const GET = route<unknown, unknown, z.infer<typeof paramsSchema>>({
  paramsSchema,
  handler: async ({ params, actor }) => {
    const record = await counts.countRecord(params.id, actor);
    const scaled = (value: bigint | null) => (value === null ? null : value.toString());
    return {
      ...record,
      createdAt: record.createdAt.toISOString(),
      confirmedAt: record.confirmedAt?.toISOString() ?? null,
      lines: record.lines.map((line) => ({
        ...line,
        expected: scaled(line.expected),
        declared: line.declared.toString(),
        counted: scaled(line.counted),
        difference: scaled(line.difference),
      })),
    };
  },
});
