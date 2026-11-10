import { normalizeDigits, parseMoney } from '@/core/money/money';
import { formatFigure } from './report-command';

/**
 * What a remittance costs, worked back from what the beneficiary is to receive.
 *
 * Each country has its bands of the sum received, and each band a price and a
 * fee for each way of paying. Figures are kept as typed, so a half-entered row
 * can be saved and simply not used.
 */

export const FEE_KINDS = ['FLAT', 'PERCENT'] as const;

export interface CountryTier {
  /** The sum received this band starts at, and ends at; empty for no end. */
  from: string;
  to: string;
  /** How many of the country's currency one shekel buys. */
  cashRate: string;
  bankRate: string;
  cashFee: string;
  bankFee: string;
  feeKind: (typeof FEE_KINDS)[number];
}

export interface CountryPrice {
  country: string;
  /** What the beneficiary is paid in, as a word: جنيه. */
  unit: string;
  tiers: CountryTier[];
}

const UNIT = 100_000_000n;

/** A typed figure as money, or null when it is blank or not a number. */
export function figureOf(value: string): bigint | null {
  const plain = normalizeDigits(value).replace(/,/g, '').trim();
  if (!/^\d{1,12}(\.\d{1,8})?$/.test(plain)) return null;
  return parseMoney(plain);
}

const roundUp = (value: bigint) => ((value + UNIT - 1n) / UNIT) * UNIT;

function tierFor(row: CountryPrice, delivered: bigint): CountryTier | null {
  return (
    row.tiers.find((tier) => {
      const from = figureOf(tier.from) ?? 0n;
      const to = tier.to.trim() ? figureOf(tier.to) : null;
      return delivered >= from && (to === null || delivered <= to);
    }) ?? null
  );
}

export interface Priced {
  pay: bigint;
  fee: bigint;
  total: bigint;
}

/** Shekels to pay for a sum received, rounded up to the whole shekel the office takes. */
export function priceFor(
  rateText: string,
  feeText: string,
  feeKind: CountryTier['feeKind'],
  delivered: bigint,
): Priced | null {
  const rate = figureOf(rateText);
  if (!rate || rate <= 0n) return null;
  const pay = roundUp((delivered * UNIT) / rate + ((delivered * UNIT) % rate > 0n ? 1n : 0n));
  const typed = feeText.trim() ? figureOf(feeText) : 0n;
  if (typed === null) return null;
  const fee = feeKind === 'PERCENT' ? roundUp((pay * typed) / (100n * UNIT)) : typed;
  return { pay, fee, total: pay + fee };
}

export const findCountry = (rows: CountryPrice[], country: string | null) =>
  rows.find((row) => row.country === country) ?? null;

/** The answer for a sum, each way of paying on its line; null when no band or price covers it. */
export function quoteCountry(
  row: CountryPrice,
  delivered: bigint,
  channel: 'CASH' | 'BANK' | null,
): string | null {
  const tier = tierFor(row, delivered);
  if (!tier) return null;
  const line = (word: string, rate: string, fee: string) => {
    const priced = priceFor(rate, fee, tier.feeKind, delivered);
    if (!priced) return null;
    return `${word}: ${formatFigure(priced.total)} شيكل (المبلغ ${formatFigure(priced.pay)}، الرسوم ${formatFigure(priced.fee)})`;
  };
  const lines = [
    channel !== 'BANK' ? line('نقدي', tier.cashRate, tier.cashFee) : null,
    channel !== 'CASH' ? line('بنكي', tier.bankRate, tier.bankFee) : null,
  ].filter((text): text is string => text !== null);
  if (lines.length === 0) return null;
  return [
    `ليصل ${formatFigure(delivered)} ${row.unit} إلى ${row.country}:`,
    ...lines,
    'والسعر ممكن يتغير.',
  ].join('\n');
}
