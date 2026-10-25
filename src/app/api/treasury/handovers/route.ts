import { z } from 'zod';
import { route } from '@/core/http/route';
import { parseMoney } from '@/core/money/money';
import { DRAWER_KINDS } from '@/modules/drawers/funding-categories';
import * as handovers from '@/modules/treasury/handover.service';
import * as counts from '@/modules/treasury/count-record.service';

/**
 * The handover, over HTTP.
 *
 * One endpoint for both sides of it, because both sides act on the same
 * document and the service decides which of them the caller is. Splitting it
 * into a treasury route and a teller route would put that decision in two
 * places, and the whole point of the document is that there is one.
 *
 * No permission is declared here beyond being signed in: which side a person is
 * on depends on the document and its direction, and the service is where that
 * is known. Declaring one permission at the door would have to be the weaker of
 * the two.
 */

const lineSchema = z.object({
  currency: z.string().min(2).max(8),
  kind: z.enum(DRAWER_KINDS).default('CASH'),
  nature: z.enum(handovers.LINE_NATURES).default('COUNTED'),
  amount: z.string(),
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('declare'),
    direction: z.enum(handovers.HANDOVER_DIRECTIONS),
    tellerId: z.string().min(1),
    lines: z.array(lineSchema).min(1).max(20),
    note: z.string().max(500).nullish(),
  }),
  z.object({
    action: z.literal('confirm'),
    id: z.string().min(1),
    counted: z
      .array(
        z.object({
          currency: z.string().min(2).max(8),
          kind: z.enum(DRAWER_KINDS).default('CASH'),
          amount: z.string(),
        }),
      )
      .max(20),
  }),
  z.object({ action: z.literal('cancel'), id: z.string().min(1), reason: z.string().min(3).max(300) }),
]);

export const GET = route({
  handler: async ({ actor }) => {
    const [waiting, recent] = await Promise.all([
      handovers.awaiting(actor),
      handovers.list(
        actor.permissions.includes('treasury.handover.manage')
          ? { limit: 20 }
          : { tellerId: actor.id, limit: 20 },
      ),
    ]);

    /*
     * What the books say the teller holds, beside each line still waiting to
     * be counted — the figure the count is about to be measured against. Only
     * for someone who counts, or the teller himself; it changes nothing.
     */
    const expected = await counts.expectedForPending([...waiting, ...recent]);
    const withExpected = <T extends { id: string; lines: { currencyCode: string; kind: string }[] }>(
      handover: T,
    ) => ({
      ...handover,
      lines: handover.lines.map((line) => ({
        ...line,
        expected:
          expected.get(`${handover.id}:${line.currencyCode}:${line.kind}`)?.toString() ?? null,
      })),
    });

    return { awaiting: waiting.map(withExpected), recent: recent.map(withExpected) };
  },
});

export const POST = route<z.infer<typeof bodySchema>>({
  bodySchema,
  handler: async ({ body, actor }) => {
    if (body.action === 'declare') {
      return handovers.create(
        {
          direction: body.direction,
          tellerId: body.tellerId,
          note: body.note ?? null,
          lines: body.lines.map((line) => ({
            currency: line.currency,
            kind: line.kind,
            nature: line.nature,
            amount: parseMoney(line.amount),
          })),
        },
        actor,
      );
    }

    if (body.action === 'confirm') {
      return handovers.confirm(
        body.id,
        body.counted.map((line) => ({
          currency: line.currency,
          kind: line.kind,
          amount: parseMoney(line.amount),
        })),
        actor,
      );
    }

    return handovers.cancel(body.id, body.reason, actor);
  },
});
