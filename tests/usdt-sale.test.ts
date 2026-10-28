// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { balancesFor, CATEGORIES } from '../src/modules/exchange/transaction-types.ts';
import { saleTotal } from '../src/modules/usdt/sale.service.ts';
import { kindOf } from '../src/modules/exchange/daily-count.service.ts';

/**
 * بيع USDT — تسجيل فقط. Pinned: the money comes in and nothing goes out, the
 * total is the coins at the teller's price at the currency's precision, and
 * the sale counts with the USDT sends in the daily count.
 */

const UNIT = 100_000_000n;

describe('a USDT sale only recorded', () => {
  it('takes the money in and moves no coins', () => {
    assert.deepEqual(balancesFor('USDT_SALE'), { intake: null, payout: 'NONE' });
    assert.ok((CATEGORIES.USDT as readonly string[]).includes('USDT_SALE'));
  });

  it('prices the coins at the typed price, to the currency', () => {
    // 100 USDT at 3.65 shekels.
    assert.equal(saleTotal(100n * UNIT, 365_000_000n, 2), 365n * UNIT);
    // 33.33 USDT at 3.651 — 121.687... rounds to 121.69.
    assert.equal(saleTotal(3_333_000_000n, 365_100_000n, 2), 12_169_000_000n);
    // A currency with no fraction rounds to the whole.
    assert.equal(saleTotal(10n * UNIT, 150_000_000n, 0), 15n * UNIT);
  });

  it('counts with the sends in the daily count', () => {
    assert.equal(kindOf('USDT_SALE', 'ILS'), 'USDT_SEND');
  });
});
