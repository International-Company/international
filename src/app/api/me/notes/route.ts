import { route } from '@/core/http/route';
import * as evaluation from '@/modules/ledger/teller-result.service';

/**
 * What the management has written to the person asking, and their reading of it.
 *
 * No permission beyond being signed in, and no id in either direction: the
 * caller is the subject. A route that took a user id would be a route that
 * could be pointed at somebody else.
 */
export const GET = route({
  handler: async ({ actor }) => {
    const notes = await evaluation.unreadFor(actor.id);
    return {
      notes: notes.map((note) => ({
        id: note.id,
        tone: note.tone,
        body: note.body,
        authorEn: note.createdBy.fullNameEn,
        authorAr: note.createdBy.fullNameAr,
        createdAt: note.createdAt.toISOString(),
      })),
    };
  },
});

export const POST = route({
  handler: async ({ actor }) => ({ read: await evaluation.markNotesRead(actor.id, actor) }),
});
