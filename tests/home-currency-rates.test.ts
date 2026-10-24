// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { publishRate, quoteExchange } from '../src/modules/exchange/rates.service.ts';
import { canonicalPair } from '../src/lib/home-currency.ts';

/**
 * The shekel is never a base.
 *
 * A dollar's price typed into ILS/USD reads "1 ILS = 2.90 USD", and the engine
 * honoured it: 100 shekels paid out 290 dollars. These pin the three guards —
 * it cannot be published, it is never read to price, and the screens always
 * open the pair the right way round.
 */

const UNIT = 100_000_000n;
const actor = { id: 'm', name: 'Manager' };

type Row = {
  id: string;
  baseCode: string;
  quoteCode: string;
  channel: string;
  buyRate: bigint;
  sellRate: bigint;
  midRate: bigint;
  effectiveFrom: Date;
};

function board(rows: Row[]) {
  return {
    currency: { findUnique: async ({ where }: { where: { code: string } }) => ({ code: where.code, decimals: 2 }) },
    exchangeRate: {
      findFirst: async ({ where }: { where: { baseCode: string; quoteCode: string; channel: string } }) =>
        rows.find(
          (row) =>
            row.baseCode === where.baseCode &&
            row.quoteCode === where.quoteCode &&
            row.channel === where.channel,
        ) ?? null,
    },
  } as never;
}

const row = (baseCode: string, quoteCode: string, buy: bigint, sell: bigint): Row => ({
  id: `${baseCode}/${quoteCode}`,
  baseCode,
  quoteCode,
  channel: 'BROKER',
  buyRate: buy,
  sellRate: sell,
  midRate: (buy + sell) / 2n,
  effectiveFrom: new Date(),
});

describe('the home currency is never a base', () => {
  it('refuses to publish a shekel-based pair, and names the right one', async () => {
    await assert.rejects(
      () =>
        publishRate(
          { baseCode: 'ILS', quoteCode: 'USD', channel: 'BROKER', buyRate: 290n * UNIT / 100n, sellRate: 3n * UNIT },
          actor,
          {} as never,
        ),
      (error: { messageKey?: string; params?: { pair?: string } }) =>
        error.messageKey === 'errors.homeCurrencyBase' && error.params?.pair === 'USD/ILS',
    );
  });

  it('never prices from a shekel-based row, even when it is the only direct one', async () => {
    const db = board([
      // the mistake: a dollar's price typed into ILS/USD
      row('ILS', 'USD', 290_000_000n, 300_000_000n),
      // the real price
      row('USD', 'ILS', 290_000_000n, 300_000_000n),
    ]);
    const quote = await quoteExchange('ILS', 'USD', 300n * UNIT, 'BROKER', db);

    // 300 shekels at the selling price of 3.00 is 100 dollars — not 870
    assert.equal(quote.toAmount, 100n * UNIT);
    assert.equal(quote.rateId, 'USD/ILS');
  });

  it('opens every pair with the shekel second', () => {
    assert.deepEqual(canonicalPair('ILS', 'USD'), ['USD', 'ILS']);
    assert.deepEqual(canonicalPair('USD', 'ILS'), ['USD', 'ILS']);
    assert.deepEqual(canonicalPair('USD', 'JOD'), ['USD', 'JOD']);
  });
});
