import { foldName } from './report-command';

/**
 * Whether a message to the private number is a Western Union notice, for the
 * group the office reads them in.
 *
 * From one of the senders the manager listed, it is a notice whatever it says,
 * and the bot does not talk to that sender. With one of the listed words in it,
 * it is passed on too, but it may be a customer asking about Western Union, so
 * the bot still answers it.
 */

export const DEFAULT_NOTICE_WORDS = ['Western Union', 'ويسترن', 'MTCN'];

export type NoticeMatch = 'SENDER' | 'WORDS' | null;

const digits = (value: string) => value.replace(/\D/g, '');

/** The sender's number, when WhatsApp gives one: a hidden number gives nothing to compare. */
function senderDigits(incoming: { senderPhone: string | null; chat: string }): string {
  const fromPhone = digits((incoming.senderPhone ?? '').split('@')[0]!.split(':')[0]!);
  if (fromPhone) return fromPhone;
  return incoming.chat.endsWith('@s.whatsapp.net')
    ? digits(incoming.chat.split('@')[0]!.split(':')[0]!)
    : '';
}

/** The same number however it was written: with or without the country code, +, 00 or spaces. */
function sameNumber(a: string, b: string): boolean {
  if (a.length < 7 || b.length < 7) return false;
  const tail = Math.min(9, a.length, b.length);
  return a.slice(-tail) === b.slice(-tail);
}

export function westernNotice(
  incoming: { text: string; senderPhone: string | null; chat: string },
  lists: { senders: string[]; keywords: string[] },
): NoticeMatch {
  const from = senderDigits(incoming);
  if (from && lists.senders.some((sender) => sameNumber(digits(sender), from))) return 'SENDER';
  const text = foldName(incoming.text);
  if (!text) return null;
  return lists.keywords.some((word) => {
    const folded = foldName(word);
    return folded.length > 0 && text.includes(folded);
  })
    ? 'WORDS'
    : null;
}
