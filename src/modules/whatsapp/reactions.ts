/**
 * Reactions on a message, kept as WhatsApp keeps them: one emoji per person,
 * replaced when they choose another, gone when they take it off. Stored as a
 * small JSON object of who → emoji; "me" is the number the inbox answers from.
 */

const MAX_PEOPLE = 50;

export function withReaction(raw: string | null | undefined, who: string, emoji: string): string | null {
  const current = readRaw(raw);
  if (emoji) current[who] = emoji.slice(0, 16);
  else delete current[who];
  const entries = Object.entries(current).slice(-MAX_PEOPLE);
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : null;
}

/** What the screen draws under a message: each emoji, how many chose it, and whether one is ours. */
export function reactionsOf(raw: string | null | undefined): { emoji: string; count: number; mine: boolean }[] {
  const grouped = new Map<string, { emoji: string; count: number; mine: boolean }>();
  for (const [who, emoji] of Object.entries(readRaw(raw))) {
    const entry = grouped.get(emoji) ?? { emoji, count: 0, mine: false };
    entry.count++;
    if (who === 'me') entry.mine = true;
    grouped.set(emoji, entry);
  }
  return [...grouped.values()];
}

function readRaw(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
