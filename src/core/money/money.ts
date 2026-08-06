/**
 * Money — exact decimal arithmetic on scaled 64-bit integers.
 *
 * Floating point is unusable for financial software: 0.1 + 0.2 !== 0.3, and a
 * currency exchange desk reconciles to the agora/cent every single day. Every
 * amount in this system is therefore a `bigint` of minor units scaled by 1e8.
 *
 *   1.00 USD        -> 100_000_000n
 *   0.00000001 USDT ->           1n   (one satoshi-equivalent)
 *
 * Eight decimal places covers fiat (2-3 dp) and USDT (6 dp) with headroom, and
 * keeps every value inside the signed 64-bit range up to ~92 billion units.
 *
 * This module is isomorphic — it runs on the server and in the browser.
 */

export const MONEY_SCALE = 8;
export const MONEY_FACTOR = 100_000_000n; // 10n ** 8n

/** Largest representable amount (~92.2 billion) before bigint overflows int64. */
export const MONEY_MAX = 9_223_372_036_854_775_807n;

export type Rounding = 'half-up' | 'half-even' | 'down' | 'up';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Parses a human-entered decimal string into scaled minor units.
 * Accepts Arabic-Indic digits, thousands separators and a leading sign.
 *
 * Digits beyond 1e-8 are truncated rather than rounded: a teller typing extra
 * precision should never see their amount silently rounded *up*.
 */
export function parseMoney(input: string | number | bigint): bigint {
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`Not a finite number: ${input}`);
    return parseMoney(input.toFixed(MONEY_SCALE));
  }

  let s = normalizeDigits(String(input)).trim();
  if (s === '') return 0n;

  // Strip grouping separators (both ASCII and Arabic thousands marks).
  s = s.replace(/[,٬ \s']/g, '');
  // Normalise Arabic decimal separator.
  s = s.replace(/٫/g, '.');
  // Allow a trailing/leading sign written either way.
  s = s.replace(/^\+/, '');

  if (!DECIMAL_PATTERN.test(s)) {
    throw new MoneyError(`Invalid decimal amount: "${input}"`);
  }

  const negative = s.startsWith('-');
  if (negative) s = s.slice(1);

  const [whole = '0', fraction = ''] = s.split('.');
  const paddedFraction = (fraction + '0'.repeat(MONEY_SCALE)).slice(0, MONEY_SCALE);

  const value = BigInt(whole) * MONEY_FACTOR + BigInt(paddedFraction || '0');
  if (value > MONEY_MAX) throw new MoneyError(`Amount exceeds maximum: "${input}"`);

  return negative ? -value : value;
}

/** Safe variant for form input — returns null instead of throwing. */
export function tryParseMoney(input: string | number | bigint): bigint | null {
  try {
    return parseMoney(input);
  } catch {
    return null;
  }
}

/** Converts Arabic-Indic and Eastern Arabic-Indic digits to ASCII. */
export function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (d) => {
    const code = d.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Renders scaled units as a plain decimal string, e.g. `1234.50`. */
export function toDecimalString(value: bigint, decimals = 2): string {
  if (decimals < 0 || decimals > MONEY_SCALE) {
    throw new MoneyError(`decimals must be between 0 and ${MONEY_SCALE}`);
  }

  const rounded = roundToDecimals(value, decimals);
  const negative = rounded < 0n;
  const abs = negative ? -rounded : rounded;

  const whole = abs / MONEY_FACTOR;
  const fraction = abs % MONEY_FACTOR;

  const sign = negative ? '-' : '';
  if (decimals === 0) return `${sign}${whole}`;

  const fractionText = fraction.toString().padStart(MONEY_SCALE, '0').slice(0, decimals);
  return `${sign}${whole}.${fractionText}`;
}

/**
 * Locale-aware display with grouping. Latin digits are used in both locales:
 * financial staff read account statements faster with a single digit system,
 * and it keeps Arabic and English exports byte-comparable.
 */
export function formatMoney(
  value: bigint,
  options: {
    decimals?: number;
    locale?: string;
    currency?: string;
    signDisplay?: 'auto' | 'always' | 'never';
  } = {},
): string {
  const { decimals = 2, locale = 'en-US', currency, signDisplay = 'auto' } = options;

  const plain = toDecimalString(value, decimals);
  const negative = plain.startsWith('-');
  const [whole = '0', fraction] = (negative ? plain.slice(1) : plain).split('.');

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fraction ? `${grouped}.${fraction}` : grouped;

  let sign = '';
  if (negative && signDisplay !== 'never') sign = '-';
  else if (!negative && signDisplay === 'always' && value !== 0n) sign = '+';

  const amount = `${sign}${body}`;
  if (!currency) return amount;

  // Currency code trails the number in both directions; the surrounding element
  // carries `dir` so the browser places it correctly in RTL.
  return locale.startsWith('ar') ? `${amount} ${currency}` : `${amount} ${currency}`;
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

export function addMoney(...values: bigint[]): bigint {
  return values.reduce((sum, v) => sum + v, 0n);
}

export function subtractMoney(a: bigint, b: bigint): bigint {
  return a - b;
}

export function negateMoney(value: bigint): bigint {
  return -value;
}

export function absMoney(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function isZero(value: bigint): boolean {
  return value === 0n;
}

/**
 * Multiplies two scaled values, returning a scaled value.
 * (a/1e8) * (b/1e8) = (a*b)/1e16, so we divide out one factor.
 */
export function multiplyScaled(a: bigint, b: bigint, rounding: Rounding = 'half-up'): bigint {
  return divideRounded(a * b, MONEY_FACTOR, rounding);
}

/** Divides two scaled values, returning a scaled value. */
export function divideScaled(a: bigint, b: bigint, rounding: Rounding = 'half-up'): bigint {
  if (b === 0n) throw new MoneyError('Division by zero');
  return divideRounded(a * MONEY_FACTOR, b, rounding);
}

/** Multiplies an amount by a plain integer or ratio without changing scale. */
export function multiplyByRatio(
  value: bigint,
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'half-up',
): bigint {
  if (denominator === 0n) throw new MoneyError('Division by zero');
  return divideRounded(value * numerator, denominator, rounding);
}

/** Applies a percentage expressed in scaled units (2.5% -> parseMoney('2.5')). */
export function percentageOf(value: bigint, percentScaled: bigint, rounding: Rounding = 'half-up'): bigint {
  return divideRounded(value * percentScaled, MONEY_FACTOR * 100n, rounding);
}

/**
 * Integer division with an explicit rounding policy. `half-even` (banker's
 * rounding) is available for statistical aggregation where `half-up` would
 * introduce a systematic upward bias.
 */
export function divideRounded(
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'half-up',
): bigint {
  if (denominator === 0n) throw new MoneyError('Division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  if (remainder === 0n) return negative ? -quotient : quotient;

  let result = quotient;
  const twiceRemainder = remainder * 2n;

  switch (rounding) {
    case 'down':
      break;
    case 'up':
      result += 1n;
      break;
    case 'half-up':
      if (twiceRemainder >= absDen) result += 1n;
      break;
    case 'half-even':
      if (twiceRemainder > absDen) result += 1n;
      else if (twiceRemainder === absDen && quotient % 2n !== 0n) result += 1n;
      break;
  }

  return negative ? -result : result;
}

/** Snaps a value to a currency's display precision. */
export function roundToDecimals(value: bigint, decimals: number, rounding: Rounding = 'half-up'): bigint {
  if (decimals >= MONEY_SCALE) return value;
  const step = 10n ** BigInt(MONEY_SCALE - decimals);
  return divideRounded(value, step, rounding) * step;
}

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

/**
 * Converts an amount using a scaled rate: `1 from = rate to`.
 * The result is snapped to the target currency's display precision so the
 * ledger never carries sub-agora dust the cashbox cannot physically hold.
 */
export function convert(
  amount: bigint,
  rate: bigint,
  targetDecimals = 2,
  rounding: Rounding = 'half-up',
): bigint {
  return roundToDecimals(multiplyScaled(amount, rate, rounding), targetDecimals, rounding);
}

/** Inverts a rate: given `1 A = r B`, returns the rate for `1 B = ? A`. */
export function invertRate(rate: bigint, rounding: Rounding = 'half-up'): bigint {
  if (rate === 0n) throw new MoneyError('Cannot invert a zero rate');
  return divideScaled(MONEY_FACTOR, rate, rounding);
}

/**
 * Splits an amount into `parts` shares that sum back exactly to the original.
 * The remainder is distributed one minor unit at a time so nothing is lost.
 */
export function allocate(amount: bigint, parts: number): bigint[] {
  if (parts <= 0) throw new MoneyError('parts must be positive');
  const n = BigInt(parts);
  const base = amount / n;
  let remainder = amount - base * n;
  const step = remainder < 0n ? -1n : 1n;
  if (remainder < 0n) remainder = -remainder;

  return Array.from({ length: parts }, (_, i) =>
    BigInt(i) < remainder ? base + step : base,
  );
}

// ---------------------------------------------------------------------------
// Serialization — bigint is not valid JSON
// ---------------------------------------------------------------------------

/** Server -> client boundary: bigint becomes a decimal string. */
export function serializeMoney(value: bigint): string {
  return value.toString();
}

/** Client -> server boundary. */
export function deserializeMoney(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  return BigInt(value);
}
