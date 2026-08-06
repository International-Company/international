import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allocate,
  convert,
  divideRounded,
  formatMoney,
  invertRate,
  MONEY_FACTOR,
  multiplyScaled,
  normalizeDigits,
  parseMoney,
  percentageOf,
  roundToDecimals,
  toDecimalString,
  tryParseMoney,
} from '../src/core/money/money.ts';

/**
 * Money arithmetic is the one place in this system where a rounding bug costs
 * real money and is invisible until reconciliation fails. These tests pin the
 * behaviour that the rest of the ledger depends on.
 */

describe('parseMoney', () => {
  it('parses plain decimals exactly', () => {
    assert.equal(parseMoney('1'), 100_000_000n);
    assert.equal(parseMoney('1.00'), 100_000_000n);
    assert.equal(parseMoney('0.5'), 50_000_000n);
    assert.equal(parseMoney('1234.56'), 123_456_000_000n);
  });

  it('handles the smallest representable unit', () => {
    assert.equal(parseMoney('0.00000001'), 1n);
  });

  it('parses negatives', () => {
    assert.equal(parseMoney('-42.5'), -4_250_000_000n);
  });

  it('strips grouping separators', () => {
    assert.equal(parseMoney('1,234,567.89'), parseMoney('1234567.89'));
    assert.equal(parseMoney(' 1 234.50 '), parseMoney('1234.50'));
  });

  it('accepts Arabic-Indic digits and the Arabic decimal separator', () => {
    // ٣٥٠٫٧٥ is 350.75 typed on an Arabic keyboard.
    assert.equal(parseMoney('٣٥٠٫٧٥'), parseMoney('350.75'));
    assert.equal(parseMoney('١٠٠٠'), parseMoney('1000'));
  });

  it('truncates beyond 8 decimals rather than rounding up', () => {
    // A teller typing extra precision must never see the amount grow.
    assert.equal(parseMoney('1.999999999'), parseMoney('1.99999999'));
  });

  it('rejects malformed input', () => {
    assert.throws(() => parseMoney('abc'));
    assert.throws(() => parseMoney('1.2.3'));
    assert.equal(tryParseMoney('abc'), null);
  });

  it('round-trips through the decimal string form', () => {
    for (const value of ['0', '1', '0.01', '999999.99', '-1234.56']) {
      assert.equal(toDecimalString(parseMoney(value), 2), Number(value).toFixed(2));
    }
  });
});

describe('normalizeDigits', () => {
  it('converts Arabic-Indic and Eastern Arabic-Indic digits', () => {
    assert.equal(normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
    assert.equal(normalizeDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
  });
});

describe('divideRounded', () => {
  it('rounds half away from zero with half-up', () => {
    assert.equal(divideRounded(5n, 2n, 'half-up'), 3n);
    assert.equal(divideRounded(-5n, 2n, 'half-up'), -3n);
  });

  it('rounds half to even with half-even', () => {
    assert.equal(divideRounded(5n, 2n, 'half-even'), 2n); // 2.5 -> 2
    assert.equal(divideRounded(7n, 2n, 'half-even'), 4n); // 3.5 -> 4
  });

  it('truncates with down and always lifts with up', () => {
    assert.equal(divideRounded(7n, 2n, 'down'), 3n);
    assert.equal(divideRounded(7n, 2n, 'up'), 4n);
  });

  it('refuses division by zero', () => {
    assert.throws(() => divideRounded(1n, 0n));
  });
});

describe('conversion', () => {
  it('applies a rate and snaps to the target precision', () => {
    const amount = parseMoney('1000');
    const rate = parseMoney('3.62');
    assert.equal(convert(amount, rate, 2), parseMoney('3620'));
  });

  it('never leaves sub-agora dust the drawer cannot hold', () => {
    const converted = convert(parseMoney('333.33'), parseMoney('3.6217'), 2);
    // Snapped to 2dp, so the last 6 scaled digits must be zero.
    assert.equal(converted % 1_000_000n, 0n);
  });

  it('inverts a rate consistently', () => {
    const rate = parseMoney('3.62');
    const inverted = invertRate(rate);
    // Round-tripping 1 unit returns to within one minor unit.
    const back = multiplyScaled(multiplyScaled(MONEY_FACTOR, rate), inverted);
    assert.ok((back - MONEY_FACTOR) < 100n && (MONEY_FACTOR - back) < 100n);
  });
});

describe('percentageOf', () => {
  it('computes a percentage of an amount', () => {
    assert.equal(percentageOf(parseMoney('200'), parseMoney('2.5')), parseMoney('5'));
    assert.equal(percentageOf(parseMoney('1000'), parseMoney('0.5')), parseMoney('5'));
  });
});

describe('allocate', () => {
  it('splits without losing or inventing a single minor unit', () => {
    const total = parseMoney('100');
    const parts = allocate(total, 3);

    assert.equal(parts.length, 3);
    assert.equal(parts.reduce((sum, part) => sum + part, 0n), total);
  });

  it('distributes the remainder one unit at a time', () => {
    const parts = allocate(10n, 3);
    assert.deepEqual(parts, [4n, 3n, 3n]);
  });

  it('handles negative totals', () => {
    const total = parseMoney('-100');
    const parts = allocate(total, 3);
    assert.equal(parts.reduce((sum, part) => sum + part, 0n), total);
  });
});

describe('roundToDecimals', () => {
  it('rounds to a currency display precision', () => {
    assert.equal(roundToDecimals(parseMoney('1.005'), 2), parseMoney('1.01'));
    assert.equal(roundToDecimals(parseMoney('1.004'), 2), parseMoney('1.00'));
  });

  it('leaves values at or below the target precision untouched', () => {
    const value = parseMoney('1.5');
    assert.equal(roundToDecimals(value, 8), value);
  });
});

describe('formatMoney', () => {
  it('groups thousands and keeps the requested precision', () => {
    assert.equal(formatMoney(parseMoney('1234567.5'), { decimals: 2 }), '1,234,567.50');
  });

  it('renders negatives with a leading sign', () => {
    assert.equal(formatMoney(parseMoney('-1234.5'), { decimals: 2 }), '-1,234.50');
  });

  it('appends a currency code when asked', () => {
    assert.equal(formatMoney(parseMoney('10'), { decimals: 2, currency: 'ILS' }), '10.00 ILS');
  });

  it('shows an explicit plus only when requested and non-zero', () => {
    assert.equal(formatMoney(parseMoney('5'), { signDisplay: 'always' }), '+5.00');
    assert.equal(formatMoney(0n, { signDisplay: 'always' }), '0.00');
  });
});

describe('floating point contrast', () => {
  it('adds exactly where IEEE-754 does not', () => {
    // 0.1 + 0.2 !== 0.3 in float; it must be exact here.
    const sum = parseMoney('0.1') + parseMoney('0.2');
    assert.equal(sum, parseMoney('0.3'));
    assert.equal(toDecimalString(sum, 2), '0.30');
  });

  it('keeps a long run of additions exact', () => {
    let total = 0n;
    for (let i = 0; i < 10_000; i++) total += parseMoney('0.01');
    assert.equal(total, parseMoney('100'));
  });
});
