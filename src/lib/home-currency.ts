/**
 * The office's own money, and which way round a pair is written.
 *
 * Every price here is said the way the board and the customer say it: how many
 * shekels a dollar is, never how many dollars a shekel is. A pair with the
 * shekel as its base reads "1 ILS = 2.90 USD" when someone types the dollar's
 * price into it — and the engine would then pay 290 dollars for 100 shekels.
 * So the shekel is never a base: it is the quote of every pair it is in.
 *
 * Between two foreign currencies (USD and JOD) either way round is a real
 * convention, so the pair keeps the order it was first offered in.
 */
export const HOME_CURRENCY = 'ILS';

/** The pair as it is published: the home currency always second. */
export function canonicalPair(from: string, to: string): [base: string, quote: string] {
  return from === HOME_CURRENCY ? [to, from] : [from, to];
}
