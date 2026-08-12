import { z } from 'zod';
import { route } from '@/core/http/route';
import { errors } from '@/core/errors/app-error';
import * as evaluation from '@/modules/ledger/teller-result.service';

/**
 * What each teller gave the office, and the notes written to them.
 *
 * The window is asked for rather than assumed: "this month" and "since he
 * started" are different questions about the same person, and a screen that
 * could only answer one of them would be answering the wrong one half the time.
 */

const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  /** Whose notes to include, when the manager has opened one person. */
  tellerId: z.string().optional(),
});

const bodySchema = z.object({
  tellerId: z.string().min(1),
  body: z.string().min(2).max(2000),
  tone: z.enum(evaluation.NOTE_TONES).default('NOTE'),
  shiftId: z.string().nullish(),
  discrepancyId: z.string().nullish(),
});

const parseDay = (value: string | undefined, fallback: Date): Date => {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['ledger.view'],
  querySchema,
  handler: async ({ query, actor }) => {
    if (!actor.branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

    // A month back by default, which is the span a manager actually talks in.
    const to = parseDay(query.to, new Date());
    const from = parseDay(query.from, new Date(to.getTime() - 30 * 86_400_000));

    const result = await evaluation.tellerResults(actor.branchId, from, to);

    return {
      base: result.base,
      from: result.from,
      to: result.to,
      // Said out loud rather than folded into the figures at par.
      unpriced: result.unpriced,
      rows: result.rows.map((row) => ({
        tellerId: row.tellerId,
        fullNameEn: row.fullNameEn,
        fullNameAr: row.fullNameAr,
        margin: row.margin.toString(),
        deals: row.deals,
        differences: row.differences.toString(),
        shortages: row.shortages,
        surpluses: row.surpluses,
        concessions: row.concessions.toString(),
        concessionCount: row.concessionCount,
        net: row.net.toString(),
        owed: row.owed.toString(),
      })),
      notes: query.tellerId
        ? (await evaluation.notesFor(query.tellerId)).map((note) => ({
            id: note.id,
            tone: note.tone,
            body: note.body,
            shift: note.shift?.reference ?? null,
            authorEn: note.createdBy.fullNameEn,
            authorAr: note.createdBy.fullNameAr,
            createdAt: note.createdAt.toISOString(),
            readAt: note.readAt?.toISOString() ?? null,
          }))
        : [],
    };
  },
});

/**
 * Writing in somebody's file, which is an act of management and declared as one.
 *
 * Marking a note read is not here — that belongs to the person it is about, and
 * lives at `/api/me/notes` where the caller is the subject and no id can be
 * pointed at anybody else. It used to be a second action on this route as well,
 * which meant one act with two doors and only one of them thought about.
 */
export const POST = route<z.infer<typeof bodySchema>>({
  permissions: ['staff.note.write'],
  bodySchema,
  handler: async ({ body, actor }) => {
    const note = await evaluation.writeNote(
      {
        tellerId: body.tellerId,
        body: body.body,
        tone: body.tone,
        shiftId: body.shiftId,
        discrepancyId: body.discrepancyId,
      },
      actor,
    );
    return { id: note.id };
  },
});
