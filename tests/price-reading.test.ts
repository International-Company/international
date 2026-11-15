// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, toDecimalString } from '../src/core/money/money.ts';
import {
  asPrice,
  flipRate,
  fromPrice,
  readInverted,
} from '../src/modules/exchange/price-exception.service.ts';

describe('a special price, the way the counter says it', () => {
  it('reads a deal handing out shekels as it is stored', async () => {
    // The customer sells dollars: 1 USD = 3.60 ILS is the stored rate itself.
    assert.equal(await readInverted('USD', 'ILS'), false);
    assert.equal(fromPrice(parseMoney('3.60'), false), parseMoney('3.60'));
  });

  it('turns over a deal handing out dollars', async () => {
    // The customer buys dollars with shekels: stored as dollars per shekel.
    assert.equal(await readInverted('ILS', 'USD'), true);
    const stored = fromPrice(parseMoney('3.60'), true);
    assert.equal(toDecimalString(stored, 8), '0.27777778');
    // And 1000 shekels at it buy what 1000 / 3.60 does.
    assert.equal(toDecimalString((parseMoney('1000') * stored) / 100_000_000n, 2), '277.78');
  });

  it('reads back as typed, to the board’s four places', () => {
    const stored = fromPrice(parseMoney('3.6450'), true);
    assert.equal(toDecimalString(BigInt(asPrice(stored, true)!), 4), '3.6450');
    assert.equal(toDecimalString(BigInt(asPrice(parseMoney('3.65'), false)!), 4), '3.6500');
    assert.equal(asPrice(null, true), null);
  });

  it('turns a rate over and back without drifting', () => {
    const rate = parseMoney('0.7078');
    assert.equal(toDecimalString(flipRate(rate), 4), '1.4128');
    assert.equal(flipRate(0n), 0n);
  });
});
