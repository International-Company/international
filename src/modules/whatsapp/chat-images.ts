import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { readProofImage } from '@/modules/exchange/proof-image';

/**
 * Photos sent to customers from the inbox, kept so the conversation shows them.
 *
 * The screen shrinks a photo before it leaves the browser, and it is checked by
 * its bytes here: it is sent on to WhatsApp and served back to staff, so it has
 * to actually be a picture.
 */

export interface ReadyImage {
  bytes: Buffer;
  mimeType: string;
}

/** The photo as sent from the screen, or a refusal the screen can show. */
export function readyImage(base64: string): ReadyImage {
  const read = readProofImage(base64);
  if (typeof read === 'string') throw errors.precondition('Not a usable photo', read);
  return read;
}

/** Keeps a photo that has been sent. `ownerId` is the teller whose number sent it, or null. */
export async function keepImage(image: ReadyImage, ownerId: string | null): Promise<string> {
  const row = await prisma.chatImage.create({
    data: {
      ownerId,
      mimeType: image.mimeType,
      size: image.bytes.length,
      data: new Uint8Array(image.bytes),
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * A photo, to whoever may read its conversation: a teller's to that teller
 * alone, the private number's to anyone with the inbox. Another teller's is
 * not found, rather than forbidden.
 */
export async function readImage(id: string, actor: { id: string }) {
  const row = await prisma.chatImage.findUnique({ where: { id } });
  if (!row || (row.ownerId && row.ownerId !== actor.id)) throw errors.notFound('ChatImage', id);
  return row;
}
