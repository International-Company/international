// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cashLedger } from '../src/modules/exchange/cash-ledger.service.ts';

/**
 * جرد عملياتي. Pinned: the box opens at zero and closes at what the teller's
 * cash movements came to; buying and selling are said from the office's side
 * and count only deals that stand; and the box after each line carries on
 * from the one before it, so the line where a count goes wrong can be found.
 */

const UNIT = 100_000_000n;

type Deal = {
  id: string;
  type?: string;
  status?: string;
  from: [string, bigint];
  to: [string, bigint];
  reversalOfId?: string | null;
  moves: [direction: 'IN' | 'OUT', currency: string, amount: bigint][];
};

function fakeDb(deals: Deal[], opening: { currencyCode: string; amount: bigint }[] = []) {
  const movements = deals.flatMap((deal, index) =>
    deal.moves.map(([direction, currency, amount]) => ({
      direction,
      amount,
      createdAt: new Date(2026, 9, 28, 9, index),
      drawer: { currencyCode: currency },
      transaction: {
        id: deal.id,
        reference: `TXN-${deal.id}`,
        type: deal.type ?? 'EXCHANGE',
        status: deal.status ?? 'POSTED',
        fromCurrency: deal.from[0],
        fromAmount: deal.from[1],
        toCurrency: deal.to[0],
        toAmount: deal.to[1],
        rate: UNIT,
        createdAt: new Date(2026, 9, 28, 9, index),
        reversalOfId: deal.reversalOfId ?? null,
      },
    })),
  );
  return {
    drawerMovement: { findMany: async () => movements },
    currency: {
      findMany: async () => [
        { code: 'ILS', decimals: 2 },
        { code: 'USD', decimals: 2 },
      ],
    },
    tellerOpening: { findMany: async () => opening },
  } as never;
}

const teller = { id: 'ahmad', name: 'Ahmad', permissions: ['exchange.transaction.view'] };
const day = { from: new Date(2026, 9, 28), to: new Date(2026, 9, 28, 23, 59) };

describe('my box for the day', () => {
  it('opens at zero and closes at what the cash came to', async () => {
    const ledger = await cashLedger(
      day,
      teller,
      fakeDb([
        // Bought 100 dollars for 300 shekels.
        {
          id: 'a',
          from: ['USD', 100n * UNIT],
          to: ['ILS', 300n * UNIT],
          moves: [
            ['IN', 'USD', 100n * UNIT],
            ['OUT', 'ILS', 300n * UNIT],
          ],
        },
        // Sold 50 dollars for 155 shekels.
        {
          id: 'b',
          from: ['ILS', 155n * UNIT],
          to: ['USD', 50n * UNIT],
          moves: [
            ['IN', 'ILS', 155n * UNIT],
            ['OUT', 'USD', 50n * UNIT],
          ],
        },
      ]),
    );

    assert.deepEqual(
      ledger.opening.map((row) => row.amount),
      [0n, 0n],
    );
    const closing = Object.fromEntries(ledger.closing.map((row) => [row.currency, row.amount]));
    assert.equal(closing.USD, 50n * UNIT);
    assert.equal(closing.ILS, -145n * UNIT);

    const [usd] = ledger.traded;
    assert.equal(usd?.currency, 'USD');
    assert.equal(usd?.bought, 100n * UNIT);
    assert.equal(usd?.sold, 50n * UNIT);
    assert.deepEqual(
      ledger.entries.map((entry) => entry.side),
      ['BUY', 'SELL'],
    );
  });

  it('carries the box from line to line', async () => {
    const ledger = await cashLedger(
      day,
      teller,
      fakeDb([
        {
          id: 'a',
          from: ['USD', 100n * UNIT],
          to: ['ILS', 300n * UNIT],
          moves: [
            ['IN', 'USD', 100n * UNIT],
            ['OUT', 'ILS', 300n * UNIT],
          ],
        },
        {
          id: 'b',
          from: ['USD', 20n * UNIT],
          to: ['ILS', 60n * UNIT],
          moves: [
            ['IN', 'USD', 20n * UNIT],
            ['OUT', 'ILS', 60n * UNIT],
          ],
        },
      ]),
    );
    const after = (index: number, currency: string) =>
      ledger.entries[index]?.running.find((row) => row.currency === currency)?.amount;
    assert.equal(after(0, 'USD'), 100n * UNIT);
    assert.equal(after(1, 'USD'), 120n * UNIT);
    assert.equal(after(1, 'ILS'), -360n * UNIT);
  });

  it('leaves a reversed deal out of buying and selling, but nets its cash', async () => {
    const ledger = await cashLedger(
      day,
      teller,
      fakeDb([
        {
          id: 'a',
          status: 'REVERSED',
          from: ['USD', 100n * UNIT],
          to: ['ILS', 300n * UNIT],
          moves: [
            ['IN', 'USD', 100n * UNIT],
            ['OUT', 'ILS', 300n * UNIT],
          ],
        },
        {
          id: 'r',
          reversalOfId: 'a',
          from: ['ILS', 300n * UNIT],
          to: ['USD', 100n * UNIT],
          moves: [
            ['IN', 'ILS', 300n * UNIT],
            ['OUT', 'USD', 100n * UNIT],
          ],
        },
      ]),
    );
    assert.equal(ledger.traded.length, 0);
    assert.ok(ledger.closing.every((row) => row.amount === 0n));
  });

  it('counts only the cash a transfer payout did not move', async () => {
    // Bought 100 dollars, paid the shekels by bank: only the dollars moved.
    const ledger = await cashLedger(
      day,
      teller,
      fakeDb([
        {
          id: 'a',
          from: ['USD', 100n * UNIT],
          to: ['ILS', 300n * UNIT],
          moves: [['IN', 'USD', 100n * UNIT]],
        },
      ]),
    );
    assert.deepEqual(
      ledger.closing.map((row) => [row.currency, row.amount]),
      [['USD', 100n * UNIT]],
    );
  });
});

describe('my box, opened by me', () => {
  it('starts from the box I entered and closes on top of it', async () => {
    const ledger = await cashLedger(
      { ...day, day: '2026-10-28' },
      teller,
      fakeDb(
        [
          {
            id: 'a',
            from: ['USD', 100n * UNIT],
            to: ['ILS', 300n * UNIT],
            moves: [
              ['IN', 'USD', 100n * UNIT],
              ['OUT', 'ILS', 300n * UNIT],
            ],
          },
        ],
        [
          { currencyCode: 'ILS', amount: 1_000n * UNIT },
          { currencyCode: 'USD', amount: 500n * UNIT },
        ],
      ),
    );
    assert.equal(ledger.openingSet, true);
    const closing = Object.fromEntries(ledger.closing.map((row) => [row.currency, row.amount]));
    assert.equal(closing.ILS, 700n * UNIT);
    assert.equal(closing.USD, 600n * UNIT);
    const opening = Object.fromEntries(ledger.opening.map((row) => [row.currency, row.amount]));
    assert.equal(opening.ILS, 1_000n * UNIT);
  });

  it('closes a currency he opened with even when nothing moved in it', async () => {
    const ledger = await cashLedger(
      { ...day, day: '2026-10-28' },
      teller,
      fakeDb([], [{ currencyCode: 'JOD', amount: 50n * UNIT }]),
    );
    assert.deepEqual(
      ledger.closing.map((row) => [row.currency, row.amount]),
      [['JOD', 50n * UNIT]],
    );
  });
});
