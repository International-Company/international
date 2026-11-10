import { normalizeDigits, parseMoney } from '@/core/money/money';
import { ANY_CHANNEL, type SheetRate } from './price-sheet';
import { currencyWord, formatFigure } from './report-command';

/**
 * A sum worked out for a customer, by the program and not the assistant.
 *
 * The assistant only says what is being asked: who is selling what, and how much.
 * The figure comes from here, from the same prices the customer is allowed to
 * see, so a price that is hidden cannot appear inside a total.
 */

export interface BotCalculation {
  /** Whether the customer hands over `currency`, or wants to receive it. */
  side: 'customer_sells' | 'customer_buys';
  currency: string;
  amount: string;
  /** What it is paid for with. */
  other_currency: string;
  /** How, when they said. */
  channel: 'CASH' | 'BANK' | null;
}

const CHANNEL_WORDS: Record<string, string> = { CASH: 'نقدي', BROKER: 'تحويل بنكي' };

/** A line per way of paying, or nothing when the prices shown cannot answer it. */
export function calculationLines(calculation: BotCalculation, rates: SheetRate[]): string[] {
  const plain = normalizeDigits(calculation.amount).replace(/,/g, '').trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(plain)) return [];
  const amount = parseMoney(plain);
  if (amount <= 0n) return [];

  const channel =
    calculation.channel === 'CASH' ? 'CASH' : calculation.channel === 'BANK' ? 'BROKER' : null;
  const matching = rates.filter(
    (rate) =>
      rate.baseCode === calculation.currency &&
      rate.quoteCode === calculation.other_currency &&
      (channel === null || rate.channel === channel || rate.channel === ANY_CHANNEL),
  );

  return matching.flatMap((rate) => {
    const price = calculation.side === 'customer_sells' ? rate.buyRate : rate.sellRate;
    if (price <= 0n) return [];
    const total = (amount * price) / 100_000_000n;
    const how =
      rate.channel === ANY_CHANNEL ? '' : ` (${CHANNEL_WORDS[rate.channel] ?? rate.channel})`;
    return [
      `${formatFigure(amount)} ${currencyWord(rate.baseCode)} = ${formatFigure(total)} ${currencyWord(rate.quoteCode)}${how}`,
    ];
  });
}
