import 'server-only';
import { prisma } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { readProofImage } from '@/modules/exchange/proof-image';

/**
 * Files in the inbox's conversations — photos, voice notes, videos and
 * documents — sent to customers or by them, kept so the conversation shows them.
 *
 * A photo sent from the screen is shrunk in the browser first and checked by its
 * bytes here: it is sent on to WhatsApp and served back to staff, so it has to
 * actually be a picture. What a customer sends is kept as WhatsApp gave it.
 */

/** Past this a file is left on the phone, and the conversation shows a clip. */
export const MAX_KEPT_MEDIA = 16 * 1024 * 1024;

export type MediaKind = 'image' | 'audio' | 'video' | 'document';

export function mediaKindOf(mimeType: string): MediaKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

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

export interface KeptMedia {
  id: string;
  kind: MediaKind;
}

/** Keeps a file. `ownerId` is the teller whose number it came through, or null for the office's. */
export async function keepMedia(
  media: { bytes: Buffer; mimeType: string; fileName?: string | null },
  ownerId: string | null,
): Promise<KeptMedia | null> {
  if (media.bytes.length === 0 || media.bytes.length > MAX_KEPT_MEDIA) return null;
  const row = await prisma.chatImage.create({
    data: {
      ownerId,
      mimeType: media.mimeType,
      fileName: media.fileName?.slice(0, 200) ?? null,
      size: media.bytes.length,
      data: new Uint8Array(media.bytes),
    },
    select: { id: true },
  });
  return { id: row.id, kind: mediaKindOf(media.mimeType) };
}

/** A photo sent from the screen, kept. */
export async function keepImage(image: ReadyImage, ownerId: string | null): Promise<string> {
  const kept = await keepMedia(image, ownerId);
  if (!kept) throw errors.precondition('Not a usable photo', 'errors.proofImageInvalid');
  return kept.id;
}

/**
 * A file, to whoever may read its conversation: a teller's to that teller
 * alone, the private number's to anyone with the inbox. Another teller's is
 * not found, rather than forbidden.
 */
export async function readImage(id: string, actor: { id: string }) {
  const row = await prisma.chatImage.findUnique({ where: { id } });
  if (!row || (row.ownerId && row.ownerId !== actor.id)) throw errors.notFound('ChatImage', id);
  return row;
}
