import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  percentCoins,
  percentOfRate,
  percentRate,
  percentTotal,
  saleCoins,
  validPercent,
} from '../src/modules/usdt/sale-sums.ts';

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

describe('a dollar sale, priced by a percentage', () => {
  const pct = (n: number) => BigInt(Math.round(n * 100)) * 1_000_000n;
  it('gives the dollars received less the share kept', () => {
    assert.equal(percentCoins(1000n * UNIT, pct(3)), 970n * UNIT);
    assert.equal(percentCoins(1000n * UNIT, 0n), 1000n * UNIT);
    assert.equal(percentCoins(333n * UNIT, pct(2.5)), cents(324.67));
  });
  it('works back from the coins to the dollars, half-up', () => {
    assert.equal(percentTotal(970n * UNIT, pct(3), 2), 1000n * UNIT);
    assert.equal(percentTotal(100n * UNIT, pct(3), 2), cents(103.09));
  });
  it('keeps the percentage in the rate so the message reads it back', () => {
    assert.equal(percentRate(pct(3)), cents(0.97));
    assert.equal(percentOfRate(percentRate(pct(2.5))), pct(2.5));
  });
  it('refuses a share of all or less than nothing', () => {
    assert.equal(validPercent(pct(100)), false);
    assert.equal(validPercent(-1n), false);
    assert.equal(percentCoins(100n * UNIT, pct(100)), 0n);
  });
});
