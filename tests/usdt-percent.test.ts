import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isPercentPair,
  payoutAtPercent,
  percentText,
  validPercent,
} from '../src/modules/usdt/percent-payout.ts';

/**
 * USDT for dollars at a percentage. Pinned: the office's cut comes off the coins,
 * only this pair is priced this way, and a cut of everything is refused.
 */

const UNIT = 100_000_000n;
const percent = (value: number) => BigInt(Math.round(value * 100)) * (UNIT / 100n);

describe('USDT for dollars at a percentage', () => {
  it('takes the cut off the coins', () => {
    assert.equal(payoutAtPercent(1000n * UNIT, percent(1), 2), 990n * UNIT);
    assert.equal(payoutAtPercent(1000n * UNIT, percent(1.5), 2), 985n * UNIT);
    assert.equal(payoutAtPercent(1000n * UNIT, 0n, 2), 1000n * UNIT);
  });

  it('rounds to what a dollar can express', () => {
    // 33.33 at 1% is 32.9967, which pays 33.00.
    assert.equal(payoutAtPercent(3_333_000_000n, percent(1), 2), 3_300_000_000n);
    // 100.55 at 2.5% is 98.03625, which pays 98.04.
    assert.equal(payoutAtPercent(10_055_000_000n, percent(2.5), 2), 9_804_000_000n);
  });

  it('applies only to USDT for dollars', () => {
    assert.equal(isPercentPair('USDT', 'USD'), true);
    assert.equal(isPercentPair('usdt', 'usd'), true);
    assert.equal(isPercentPair('USDT', 'ILS'), false);
    assert.equal(isPercentPair('USD', 'ILS'), false);
  });

  it('refuses a cut below nothing or of everything', () => {
    assert.equal(validPercent(0n), true);
    assert.equal(validPercent(percent(99.99)), true);
    assert.equal(validPercent(100n * UNIT), false);
    assert.equal(validPercent(-1n), false);
  });

  it('writes a percentage without its trailing zeros', () => {
    assert.equal(percentText(percent(1.5)), '1.5');
    assert.equal(percentText(percent(2)), '2');
    assert.equal(percentText(percent(10)), '10');
    assert.equal(percentText(0n), '0');
  });
});
