/**
 * The office can link two WhatsApp numbers. Each writes to the groups it is a
 * member of, so a message goes out from whichever number is in its group, and
 * the manager only ever chooses groups.
 */

export const ACCOUNTS = ['main', 'second', 'private'] as const;
export type Account = (typeof ACCOUNTS)[number];

/** The numbers that write to groups. The private number only ever answers people. */
export const GROUP_ACCOUNTS = ['main', 'second'] as const satisfies readonly Account[];

/** A chat with one person: not a group, a status or a channel. */
export const isPrivateChat = (jid: string): boolean =>
  jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

/** Where an account's session is kept: the first as it always was, the second apart. */
export const SESSION_PREFIX: Record<Account, string> = {
  main: '',
  second: 'second:',
  private: 'private:',
};

/**
 * The number to write to a chat with. A group goes to a number that is in it,
 * the first one when both are; anything else, or a group neither is known to
 * be in, to the first number that is linked. Null when none is.
 */
export function chooseAccount(
  jid: string,
  live: readonly Account[],
  memberOf: Partial<Record<Account, ReadonlySet<string>>>,
): Account | null {
  if (live.length === 0) return null;
  if (jid.endsWith('@g.us')) {
    const member = live.find((account) => memberOf[account]?.has(jid));
    if (member) return member;
  }
  return live[0]!;
}

/** Whether a message has already been handled, when both numbers are in the chat it came to. */
export function firstSighting(seen: string[], key: string, keep = 500): boolean {
  if (seen.includes(key)) return false;
  seen.push(key);
  if (seen.length > keep) seen.splice(0, seen.length - keep);
  return true;
}
