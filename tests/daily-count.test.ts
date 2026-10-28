// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dailyCount, kindOf } from '../src/modules/exchange/daily-count.service.ts';

/**
 * الجرد اليومي. Pinned: each deal lands in its own list — USDT in, USDT out,
 * bought, sold — and a deal undone later stays listed but out of the totals.
 */

const UNIT = 100_000_000n;

type Deal = {
  id: string;
  type: string;
  status?: string;
  from: [string, bigint];
  to: [string, bigint];
};

function fakeDb(deals: Deal[]) {
  return {
    transaction: {
      findMany: async () =>
        deals.map((deal, index) => ({
          id: deal.id,
          reference: `TXN-${deal.id}`,
          type: deal.type,
          status: deal.status ?? 'POSTED',
          createdAt: new Date(2026, 9, 28, 9, index),
          fromCurrency: deal.from[0],
          fromAmount: deal.from[1],
          toCurrency: deal.to[0],
          toAmount: deal.to[1],
          payoutBankAmount: 0n,
          payoutBankChannel: null,
          counterpartyName: null,
          customer: null,
        })),
    },
  } as never;
}

const teller = { id: 'ahmad', name: 'Ahmad', permissions: ['exchange.transaction.view'] };
const day = { from: new Date(2026, 9, 28), to: new Date(2026, 9, 28, 23, 59) };

describe('the daily count', () => {
  it('sorts deals by kind', () => {
    assert.equal(kindOf('USDT_RECEIVE', 'USDT'), 'USDT_RECEIVE');
    assert.equal(kindOf('USDT_SEND', 'ILS'), 'USDT_SEND');
    assert.equal(kindOf('EXCHANGE', 'USD'), 'BUY');
    assert.equal(kindOf('EXCHANGE', 'ILS'), 'SELL');
    assert.equal(kindOf('REMITTANCE_OUT', 'ILS'), null);
  });

  it('totals each list, leaving undone deals listed but uncounted', async () => {
    const count = await dailyCount(
      day,
      teller,
      fakeDb([
        { id: 'a', type: 'USDT_RECEIVE', from: ['USDT', 100n * UNIT], to: ['USD', 99n * UNIT] },
        { id: 'b', type: 'USDT_RECEIVE', from: ['USDT', 50n * UNIT], to: ['ILS', 150n * UNIT] },
        { id: 'c', type: 'USDT_SEND', from: ['USD', 102n * UNIT], to: ['USDT', 100n * UNIT] },
        { id: 'd', type: 'EXCHANGE', from: ['USD', 100n * UNIT], to: ['ILS', 300n * UNIT] },
        {
          id: 'e',
          type: 'EXCHANGE',
          status: 'REVERSED',
          from: ['USD', 10n * UNIT],
          to: ['ILS', 30n * UNIT],
        },
        { id: 'f', type: 'EXCHANGE', from: ['ILS', 155n * UNIT], to: ['USD', 50n * UNIT] },
      ]),
    );
    const by = Object.fromEntries(count.groups.map((group) => [group.kind, group]));

    assert.deepEqual(
      count.groups.map((group) => group.kind),
      ['USDT_RECEIVE', 'USDT_SEND', 'BUY', 'SELL'],
    );
    assert.equal(by.USDT_RECEIVE?.count, 2);
    assert.deepEqual(by.USDT_RECEIVE?.received, [{ currency: 'USDT', amount: 150n * UNIT }]);
    assert.deepEqual(by.USDT_RECEIVE?.paid, [
      { currency: 'ILS', amount: 150n * UNIT },
      { currency: 'USD', amount: 99n * UNIT },
    ]);
    assert.equal(by.USDT_SEND?.count, 1);

    assert.equal(by.BUY?.count, 1);
    assert.equal(by.BUY?.entries.length, 2);
    assert.deepEqual(by.BUY?.received, [{ currency: 'USD', amount: 100n * UNIT }]);
    assert.deepEqual(by.SELL?.paid, [{ currency: 'USD', amount: 50n * UNIT }]);
  });
});
