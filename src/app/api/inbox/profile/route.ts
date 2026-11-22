import { z } from 'zod';
import { route } from '@/core/http/route';
import { toJsonSafe } from '@/core/http/json';
import { addNote, chatProfile, removeNote } from '@/modules/whatsapp/inbox-profile.service';

const scope = z.enum(['bot', 'teller']);
const querySchema = z.object({ scope, chatId: z.string().min(1).max(40) });

/** Who the conversation is with: their record, their dealings, the staff's notes. */
export const GET = route<unknown, z.infer<typeof querySchema>>({
  permissions: ['customers.whatsapp'],
  querySchema,
  handler: async ({ query, actor }) => toJsonSafe(await chatProfile(actor.id, query.scope, query.chatId)),
});

const noteSchema = z.object({ scope, chatId: z.string().min(1).max(40), text: z.string().trim().min(1).max(1000) });

/** A note kept on the conversation, never sent. */
export const POST = route<z.infer<typeof noteSchema>>({
  permissions: ['customers.whatsapp'],
  bodySchema: noteSchema,
  handler: async ({ body, actor, session }) =>
    toJsonSafe(
      await addNote({ id: actor.id, name: session.user.fullNameAr || actor.name }, body.scope, body.chatId, body.text),
    ),
});

const removeSchema = z.object({ scope, chatId: z.string().min(1).max(40), noteId: z.string().min(1).max(40) });

/** A note removed, by the one who wrote it; named in the address, as a removal carries no body. */
export const DELETE = route<unknown, z.infer<typeof removeSchema>>({
  permissions: ['customers.whatsapp'],
  querySchema: removeSchema,
  handler: async ({ query, actor }) => toJsonSafe(await removeNote(actor.id, query.scope, query.chatId, query.noteId)),
});
