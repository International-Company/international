/** What the bot puts on a transfer's message once it was sent from the bank. */
export const SENT_MARK = '✅';

/**
 * The answer under a sent transfer in the transfers group: the number it went
 * to, then that it went — so whoever reads the group sees which one at once.
 */
export function sentWords(account: string | null | undefined): string {
  const number = account?.trim();
  return number ? `${number}\n${SENT_MARK} تم التحويل` : `${SENT_MARK} تم التحويل`;
}
