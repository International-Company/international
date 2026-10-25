import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import * as tills from '@/modules/treasury/till-count.service';

/**
 * جرد الصندوق over HTTP: what a teller should hold, the cash the safe gives or
 * takes between counts, and the count itself. Every part of it is for someone
 * who counts; the service holds that rule.
 */

const querySchema = z.object({ tellerId: z.string().min(1).optional() });

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('adjust'),
    tellerId: z.string().min(1),
    currency: z.string().min(2).max(8),
    direction: z.enum(['IN', 'OUT']),
    amount: z.string(),
    note: z.string().max(300).nullish(),
  }),
  z.object({
    action: z.literal('count'),
    tellerId: z.string().min(1),
    lines: z
      .array(
        z.object({
          currency: z.string().min(2).max(8),
          counted: z.string(),
          kept: z.string().nullish(),
          opening: z.string().nullish(),
          denominations: z.string().max(2000).nullish(),
        }),
      )
      .min(1)
      .max(30),
    note: z.string().max(500).nullish(),
  }),
]);

const scaled = (value: bigint) => value.toString();

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['treasury.handover.manage'],
  querySchema,
  handler: async ({ query, actor }) => {
    if (query.tellerId) {
      const books = await tills.preview(query.tellerId, actor);
      return {
        ...books,
        periodStart: books.periodStart.toISOString(),
        periodEnd: books.periodEnd.toISOString(),
        previous: books.previous && {
          reference: books.previous.reference,
          createdAt: books.previous.createdAt.toISOString(),
        },
        lines: books.lines.map((line) => ({
          currency: line.currency,
          opening: scaled(line.opening),
          received: scaled(line.received),
          paid: scaled(line.paid),
          toppedUp: scaled(line.toppedUp),
          drawn: scaled(line.drawn),
          expected: scaled(line.expected),
        })),
      };
    }

    const recent = await tills.list(actor, { limit: 30 });
    return {
      recent: recent.map((count) => ({
        id: count.id,
        reference: count.reference,
        teller: count.teller,
        countedBy: count.countedBy,
        createdAt: count.createdAt.toISOString(),
        lines: count.lines.map((line) => ({
          currency: line.currencyCode,
          expected: scaled(line.expected),
          counted: scaled(line.counted),
          difference: scaled(line.difference),
        })),
      })),
    };
  },
});

export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['treasury.handover.manage'],
  bodySchema,
  handler: async ({ body, actor }) => {
    if (body.action === 'adjust') {
      const row = await tills.adjust(
        {
          tellerId: body.tellerId,
          currency: body.currency,
          direction: body.direction,
          amount: parseMoney(body.amount),
          note: body.note ?? null,
        },
        actor,
      );
      return { id: row.id };
    }

    const count = await tills.record(
      {
        tellerId: body.tellerId,
        note: body.note ?? null,
        lines: body.lines.map((line) => ({
          currency: line.currency,
          counted: parseMoney(line.counted),
          kept: line.kept ? parseMoney(line.kept) : null,
          opening: line.opening ? parseMoney(line.opening) : null,
          denominations: line.denominations ?? null,
        })),
      },
      actor,
    );
    return { id: count.id, reference: count.reference };
  },
});
