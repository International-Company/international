import { convert, invertRate, parseMoney } from '@/core/money/money';
import { HOME_CURRENCY } from '@/lib/home-currency';

/**
 * The machine's price worked out on the screen, from the board it already
 * holds, the moment a digit is typed — so the teller is not left waiting on a
 * round trip to read a figure aloud.
 *
 * Only ever shown until the server's own answer lands: recording waits for
 * that, and the server prices again from its board before it posts. The
 * arithmetic is the server's (`quoteExchange`, `quoteReverse`), step for step,
 * so with a board that is current the two agree to the unit; when they do not,
 * the board was stale, and the screen stops guessing for that pair.
 */

export interface EstimateRate {
  baseCode: string;
  quoteCode: string;
  channel?: string;
  buyRate: string;
  sellRate: string;
  effectiveFrom?: string;
}

export interface EstimatedLeg {
  fromAmount: string;
  toAmount: string;
  rate: string;
  profit: null;
}

type Channel = 'CASH' | 'BROKER';

/** The newest published row for the pair on that channel, as the server reads it. */
function rowFor(rates: EstimateRate[], base: string, quote: string, channel: Channel) {
  return rates
    .filter((rate) => rate.baseCode === base && rate.quoteCode === quote && (rate.channel ?? 'CASH') === channel)
    .sort((a, b) => (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? ''))[0];
}

/** The rate a customer handing over `from` gets in `to`, or null when none is published. */
export function rateFor(rates: EstimateRate[], from: string, to: string, channel: Channel): bigint | null {
  if (from === to) return null;
  // Bought directly: FROM/TO at the buying price. A row based on the shekel is never read.
  const direct = from === HOME_CURRENCY ? null : rowFor(rates, from, to, channel);
  if (direct) return BigInt(direct.buyRate);
  // Sold: TO/FROM at the selling price, turned round.
  const reverse = to === HOME_CURRENCY ? null : rowFor(rates, to, from, channel);
  if (reverse && BigInt(reverse.sellRate) > 0n) return invertRate(BigInt(reverse.sellRate));
  return null;
}

/** One channel priced for what the customer hands over. */
export function legFor(
  rates: EstimateRate[],
  from: string,
  to: string,
  channel: Channel,
  fromAmount: bigint,
  toDecimals: number,
): EstimatedLeg | null {
  const rate = rateFor(rates, from, to, channel);
  if (rate === null || fromAmount <= 0n) return null;
  return {
    fromAmount: fromAmount.toString(),
    toAmount: convert(fromAmount, rate, toDecimals).toString(),
    rate: rate.toString(),
    profit: null,
  };
}

/**
 * Both channels, from a figure typed on either side. A figure the customer is
 * to take away is sized against `through` first, as the server sizes it.
 */
export function estimate(input: {
  rates: EstimateRate[];
  from: string;
  to: string;
  side: 'pay' | 'receive';
  amount: string;
  through: Channel;
  fromDecimals: number;
  toDecimals: number;
}): { cash: EstimatedLeg | null; broker: EstimatedLeg | null } | null {
  let typed: bigint;
  try {
    typed = parseMoney(input.amount);
  } catch {
    return null;
  }
  if (typed <= 0n) return null;

  let paid = typed;
  if (input.side === 'receive') {
    const unit = rateFor(input.rates, input.from, input.to, input.through);
    if (unit === null || unit <= 0n) return null;
    // The rate turned round sizes what is handed over — then it is priced forwards.
    paid = convert(typed, invertRate(unit), input.fromDecimals, 'half-up');
    if (paid <= 0n) return null;
  }

  const cash = legFor(input.rates, input.from, input.to, 'CASH', paid, input.toDecimals);
  const broker = legFor(input.rates, input.from, input.to, 'BROKER', paid, input.toDecimals);
  if (!cash && !broker) return null;
  return { cash, broker };
}
