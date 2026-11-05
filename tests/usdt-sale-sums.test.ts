import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { saleCoins } from '../src/modules/usdt/sale-sums.ts';

const UNIT = 100_000_000n;
const cents = (value: number) => (BigInt(Math.round(value * 100)) * UNIT) / 100n;

describe('the USDT a sum received buys', () => {
  it('divides by the price', () => {
    assert.equal(saleCoins(1850n * UNIT, cents(3.7)), 500n * UNIT);
    assert.equal(saleCoins(990n * UNIT, cents(0.99)), 1000n * UNIT);
  });

  it('rounds down to two places, never promising more than was paid for', () => {
    assert.equal(saleCoins(1000n * UNIT, cents(3.7)), cents(270.27));
    assert.equal(saleCoins(10n * UNIT, cents(3.7)), cents(2.7));
  });

  it('is nothing without a sum and a price', () => {
    assert.equal(saleCoins(0n, cents(3.7)), 0n);
    assert.equal(saleCoins(100n * UNIT, 0n), 0n);
    assert.equal(saleCoins(1n, cents(3.7)), 0n);
  });
});
