/**
 * Whether a message the office sent to a customer can still be put right.
 *
 * WhatsApp edits a message for the other side for a quarter of an hour after it
 * went, and deletes it for them for about two days. The windows here are a little
 * shorter than WhatsApp's, so a change asked for at the edge is not one WhatsApp
 * then quietly ignores while the screen says it was made.
 *
 * Only words are edited: a photo's caption or a file is deleted and sent again.
 */

export const EDIT_WINDOW_MS = 14 * 60 * 1000;
export const DELETE_WINDOW_MS = 47 * 60 * 60 * 1000;

export interface SentMessage {
  /** Sent by the office — the bot, the staff, or the teller — not by the customer. */
  ours: boolean;
  /** WhatsApp's id for it: without one there is nothing to point WhatsApp at. */
  waId: string | null;
  mediaKind: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export type Change = 'edit' | 'delete';

/** Why this change cannot be made, as an error key, or null when it can. */
export function changeRefusal(
  message: SentMessage,
  change: Change,
  now: number = Date.now(),
): string | null {
  if (!message.ours) return 'errors.inboxNotOurs';
  if (!message.waId) return 'errors.inboxCannotChange';
  if (message.deletedAt) return 'errors.inboxAlreadyDeleted';
  const age = now - message.createdAt.getTime();
  if (change === 'edit') {
    if (message.mediaKind) return 'errors.inboxEditMedia';
    if (age > EDIT_WINDOW_MS) return 'errors.inboxEditTooLate';
    return null;
  }
  if (age > DELETE_WINDOW_MS) return 'errors.inboxDeleteTooLate';
  return null;
}

/** What the screen may offer on a message: an edit, a deletion, both or neither. */
export function changesAllowed(message: SentMessage, now: number = Date.now()) {
  return {
    editable: changeRefusal(message, 'edit', now) === null,
    deletable: changeRefusal(message, 'delete', now) === null,
  };
}
