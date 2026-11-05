import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { changeOf } from '../src/modules/exchange/intake-split.ts';

const UNIT = 100_000_000n;

describe('what is left of what the customer handed over', () => {
  it('is the difference', () => {
    assert.equal(changeOf(400n * UNIT, 310n * UNIT), 90n * UNIT);
  });

  it('is nothing when they handed over just enough, too little, or nothing was typed', () => {
    assert.equal(changeOf(310n * UNIT, 310n * UNIT), 0n);
    assert.equal(changeOf(300n * UNIT, 310n * UNIT), 0n);
    assert.equal(changeOf(0n, 310n * UNIT), 0n);
  });
});
