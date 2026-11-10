/**
 * Whether what was typed reads as a person's whole name: two words at least, of
 * letters, so that half a name is never recorded and sent to a group.
 */
export function isFullName(text: string): boolean {
  const words = text.trim().split(/\s+/);
  return words.length >= 2 && words.every((word) => /^[\p{L}\p{M}'’.-]{2,}$/u.test(word));
}
