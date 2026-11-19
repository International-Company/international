/**
 * What a reaction on a transfer's message says in the groups:
 *
 *   ❤️  the transfer was passed on to whoever carries it out;
 *   👍  it was carried out.
 *
 * Only the red heart counts as passed on, and the thumb whatever its skin tone.
 * Anything else is talk, and read as nothing.
 *
 * Pure, so the rule can be read and tested on its own.
 */
export type GroupMark = 'forwarded' | 'done';

export function markOf(emoji: string): GroupMark | null {
  // The same emoji comes with or without its colour selector, and a thumb in five skin tones.
  const bare = emoji.replace(/[️\u{1F3FB}-\u{1F3FF}]/gu, '').trim();
  if (bare === '❤') return 'forwarded';
  if (bare === '\u{1F44D}') return 'done';
  return null;
}

/**
 * A message's words as two copies of it share them: forwarding on WhatsApp keeps
 * the words, but a phone may add or drop direction marks and trailing spaces.
 */
export function wordsOf(text: string): string {
  return text
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** How a reaction's mark is named on the desk: the heart, and who put it. */
export function markedBy(name: string | null, phone: string | null): string {
  const who = name?.trim() || (phone ? `+${phone}` : '');
  return who ? `❤️ ${who}` : '❤️';
}
