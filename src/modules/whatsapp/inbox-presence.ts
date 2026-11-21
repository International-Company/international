/**
 * Who is in which customer conversation right now, so two people do not answer
 * the same customer at once.
 *
 * Each open conversation is reported by the screen every few seconds — whose,
 * and whether something is being typed in it — and forgotten once the reports
 * stop. Kept in memory: it is a matter of the last minute, not a record, and a
 * restart forgets nothing anyone needs.
 *
 * Matched by the customer's number, not the conversation, so it holds whether
 * the tellers share one linked number or the customer wrote to two of them.
 */

/** A report older than this is someone who has left. */
const FRESH_MS = 45_000;

interface Presence {
  userId: string;
  name: string;
  phone: string;
  typing: boolean;
  at: number;
}

const holder = globalThis as unknown as { __inboxPresence?: Map<string, Presence> };
const present = (holder.__inboxPresence ??= new Map<string, Presence>());

/** This person has this customer's conversation open — or none, when `phone` is null. */
export function report(user: { id: string; name: string }, phone: string | null, typing: boolean, now = Date.now()) {
  for (const [key, entry] of present) {
    if (entry.userId === user.id && entry.phone !== phone) present.delete(key);
  }
  if (!phone) return;
  present.set(`${phone}:${user.id}`, { userId: user.id, name: user.name, phone, typing, at: now });
}

/** Everyone else in a conversation now: by customer number, who, and whether they are typing. */
export function busyFor(viewerId: string, now = Date.now()) {
  const busy: { phone: string; name: string; typing: boolean }[] = [];
  for (const [key, entry] of present) {
    if (now - entry.at > FRESH_MS) {
      present.delete(key);
      continue;
    }
    if (entry.userId !== viewerId) busy.push({ phone: entry.phone, name: entry.name, typing: entry.typing });
  }
  return busy;
}
