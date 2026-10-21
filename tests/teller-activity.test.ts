// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activity, balanceFlow } from '../src/modules/exchange/activity.service.ts';

/**
 * What a teller did, added up.
 *
 * The counting rules are the whole of this screen, and each one is a way a
 * manager could be told something untrue: a reversed deal counted as work, a
 * reversal counted as the manager's trading, dollars added to shekels, a margin
 * shown to someone not allowed it. Each is pinned against a fake table, so the
 * rules are tested without a database standing behind them.
 */

const UNIT = 100_000_000n;
const at = new Date('2026-10-21T10:00:00Z');

type Row = {
  createdById: string;
  type: string;
  status: string;
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency: string;
  toAmount: bigint;
  profitAmount: bigint;
  createdAt: Date;
};

const row = (patch: Partial<Row>): Row => ({
  createdById: 'ahmad',
  type: 'EXCHANGE',
  status: 'POSTED',
  fromCurrency: 'USD',
  fromAmount: 100n * UNIT,
  toCurrency: 'ILS',
  toAmount: 290n * UNIT,
  profitAmount: 5n * UNIT,
  createdAt: at,
  ...patch,
});

/** A table the service can read, which also remembers what it was asked. */
function fakeDb(rows: Row[]) {
  const asked: unknown[] = [];
  return {
    asked,
    db: {
      transaction: {
        findMany: async (args: unknown) => {
          asked.push(args);
          return rows;
        },
      },
      user: {
        findMany: async () => [
          { id: 'ahmad', fullNameEn: 'Ahmad', fullNameAr: 'أحمد' },
          { id: 'sami', fullNameEn: 'Sami', fullNameAr: 'سامي' },
        ],
      },
    } as never,
  };
}

const manager = {
  id: 'boss',
  name: 'Boss',
  branchId: 'main',
  permissions: ['exchange.transaction.viewAll', 'exchange.margin.view'],
};
const window = { from: new Date('2026-10-21T00:00:00Z'), to: new Date('2026-10-21T23:59:59Z') };

describe('teller activity', () => {
  it('is the manager’s, not anyone’s', async () => {
    const { db } = fakeDb([]);
    await assert.rejects(
      () => activity(window, { ...manager, permissions: ['exchange.transaction.view'] }, db),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
  });

  it('asks only for this branch and leaves reversal rows out', async () => {
    const { db, asked } = fakeDb([]);
    await activity(window, manager, db);
    const where = (asked[0] as { where: Record<string, unknown> }).where;
    assert.equal(where.branchId, 'main');
    assert.equal(where.reversalOfId, null);
  });

  it('counts each teller by the three kinds of work', async () => {
    const { db } = fakeDb([
      row({}),
      row({ type: 'EXCHANGE' }),
      row({ type: 'REMITTANCE_OUT', fromCurrency: 'ILS', toCurrency: 'ILS' }),
      row({ type: 'REMITTANCE_IN', fromCurrency: 'ILS', toCurrency: 'ILS' }),
      row({ type: 'USDT_RECEIVE', createdById: 'sami', fromCurrency: 'USDT' }),
    ]);

    const result = await activity(window, manager, db);
    const ahmad = result.tellers.find((teller) => teller.tellerId === 'ahmad')!;
    const sami = result.tellers.find((teller) => teller.tellerId === 'sami')!;

    assert.deepEqual(ahmad.counts, { EXCHANGE: 2, REMITTANCE: 2, USDT: 0 });
    assert.equal(ahmad.total, 4);
    assert.deepEqual(sami.counts, { EXCHANGE: 0, REMITTANCE: 0, USDT: 1 });
    assert.equal(result.tellers[0]?.tellerId, 'ahmad', 'busiest first');
  });

  it('counts a reversed deal apart, and keeps it out of every total', async () => {
    const { db } = fakeDb([row({}), row({ status: 'REVERSED', fromAmount: 900n * UNIT })]);

    const result = await activity(window, manager, db);
    const exchange = result.types.find((totals) => totals.type === 'EXCHANGE')!;

    assert.equal(result.tellers[0]?.total, 1);
    assert.equal(result.tellers[0]?.reversed, 1);
    assert.equal(exchange.count, 1);
    assert.equal(exchange.reversed, 1);
    assert.deepEqual(exchange.received, [{ currency: 'USD', amount: 100n * UNIT }]);
  });

  it('keeps every currency to itself', async () => {
    const { db } = fakeDb([
      row({ fromCurrency: 'USD', fromAmount: 100n * UNIT }),
      row({ fromCurrency: 'USD', fromAmount: 50n * UNIT }),
      row({ fromCurrency: 'JOD', fromAmount: 70n * UNIT }),
    ]);

    const exchange = (await activity(window, manager, db)).types.find(
      (totals) => totals.type === 'EXCHANGE',
    )!;

    assert.deepEqual(exchange.received, [
      { currency: 'JOD', amount: 70n * UNIT },
      { currency: 'USD', amount: 150n * UNIT },
    ]);
    assert.deepEqual(exchange.paid, [{ currency: 'ILS', amount: 870n * UNIT }]);
  });

  it('counts a promise as work, and says it is still a promise', async () => {
    const { db } = fakeDb([row({}), row({ status: 'PENDING_TRANSFER' })]);
    const exchange = (await activity(window, manager, db)).types.find(
      (totals) => totals.type === 'EXCHANGE',
    )!;

    assert.equal(exchange.count, 2);
    assert.equal(exchange.pending, 1);
  });

  it('narrows the totals to one teller and leaves the table whole', async () => {
    const { db } = fakeDb([row({}), row({ createdById: 'sami', fromAmount: 7n * UNIT })]);

    const result = await activity({ ...window, tellerId: 'sami' }, manager, db);
    const exchange = result.types.find((totals) => totals.type === 'EXCHANGE')!;

    assert.equal(result.tellers.length, 2, 'the table still shows everybody');
    assert.deepEqual(exchange.received, [{ currency: 'USD', amount: 7n * UNIT }]);
  });

  it('shows the margin only to someone allowed it', async () => {
    const { db } = fakeDb([row({})]);

    const withMargin = await activity(window, manager, db);
    const without = await activity(
      window,
      { ...manager, permissions: ['exchange.transaction.viewAll'] },
      db,
    );

    assert.deepEqual(withMargin.types.find((totals) => totals.type === 'EXCHANGE')?.margin, [
      { currency: 'ILS', amount: 5n * UNIT },
    ]);
    assert.equal(without.canSeeMargin, false);
    assert.ok(without.types.every((totals) => totals.margin === null));
  });
});

/**
 * A teller's report on himself.
 *
 * The one rule that matters more than any figure on it: it is his and nobody
 * else's, whoever asks and however.
 */
describe('a teller reading his own work', () => {
  const teller = {
    id: 'ahmad',
    name: 'Ahmad',
    branchId: 'main',
    permissions: ['exchange.transaction.view'],
  };

  it('is narrowed to him in the query itself', async () => {
    const { db, asked } = fakeDb([]);
    await activity({ ...window, own: true }, teller, db);
    const where = (asked[0] as { where: Record<string, unknown> }).where;
    assert.equal(where.createdById, 'ahmad');
  });

  it('cannot be pointed at somebody else', async () => {
    const { db, asked } = fakeDb([]);
    await activity({ ...window, own: true, tellerId: 'sami' }, teller, db);
    const where = (asked[0] as { where: Record<string, unknown> }).where;
    assert.equal(where.createdById, 'ahmad', 'his own, whatever else is asked for');
  });

  it('still needs the right to see a transaction at all', async () => {
    const { db } = fakeDb([]);
    await assert.rejects(
      () => activity({ ...window, own: true }, { ...teller, permissions: [] }, db),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
  });

  it('does not reach the office view without the manager’s permission', async () => {
    const { db } = fakeDb([]);
    await assert.rejects(
      () => activity(window, teller, db),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
  });

  it('never shows him the margin', async () => {
    const { db } = fakeDb([row({})]);
    const result = await activity({ ...window, own: true }, teller, db);
    assert.ok(result.types.every((totals) => totals.margin === null));
  });
});

describe('what his work did to his balances', () => {
  const teller = {
    id: 'ahmad',
    name: 'Ahmad',
    branchId: 'main',
    permissions: ['exchange.transaction.view'],
  };

  function flowDb(
    drawers: {
      id: string;
      currencyCode: string;
      kind: string;
      balance: bigint;
      isActive: boolean;
    }[],
    movements: { drawerId: string; direction: string; amount: bigint; reason: string }[],
  ) {
    const asked: Record<string, unknown>[] = [];
    return {
      asked,
      db: {
        drawer: {
          findMany: async (args: { where: Record<string, unknown> }) => {
            asked.push(args.where);
            return drawers.map((drawer) => ({ ...drawer, currency: { decimals: 2 } }));
          },
        },
        drawerMovement: { findMany: async () => movements },
      } as never,
    };
  }

  it('reads only his own drawers', async () => {
    const { db, asked } = flowDb([], []);
    await balanceFlow(window, teller, db);
    assert.equal(asked[0]?.ownerKey, 'teller:ahmad');
  });

  it('splits every movement by why it happened', async () => {
    const { db } = flowDb(
      [{ id: 'ils', currencyCode: 'ILS', kind: 'CASH', balance: 1_300n * UNIT, isActive: true }],
      [
        { drawerId: 'ils', direction: 'IN', amount: 1_000n * UNIT, reason: 'HANDOVER' },
        { drawerId: 'ils', direction: 'IN', amount: 600n * UNIT, reason: 'TRANSACTION' },
        { drawerId: 'ils', direction: 'OUT', amount: 290n * UNIT, reason: 'TRANSACTION' },
        { drawerId: 'ils', direction: 'IN', amount: 290n * UNIT, reason: 'REVERSAL' },
        { drawerId: 'ils', direction: 'OUT', amount: 300n * UNIT, reason: 'HANDOVER' },
        { drawerId: 'ils', direction: 'OUT', amount: 0n, reason: 'DIFFERENCE' },
      ],
    );

    const [ils] = await balanceFlow(window, teller, db);

    assert.equal(ils?.handedIn, 1_000n * UNIT);
    assert.equal(ils?.tradeIn, 890n * UNIT, 'a reversal giving money back is part of his trading');
    assert.equal(ils?.tradeOut, 290n * UNIT);
    assert.equal(ils?.handedBack, 300n * UNIT);
    assert.equal(ils?.balance, 1_300n * UNIT);
  });

  it('keeps a closed drawer only if it moved or still holds something', async () => {
    const { db } = flowDb(
      [
        { id: 'open', currencyCode: 'ILS', kind: 'CASH', balance: 0n, isActive: true },
        { id: 'idle', currencyCode: 'JOD', kind: 'CASH', balance: 0n, isActive: false },
        { id: 'used', currencyCode: 'USD', kind: 'CASH', balance: 0n, isActive: false },
      ],
      [{ drawerId: 'used', direction: 'OUT', amount: 50n * UNIT, reason: 'HANDOVER' }],
    );

    const flows = await balanceFlow(window, teller, db);
    assert.deepEqual(
      flows.map((flow) => flow.currency),
      ['ILS', 'USD'],
    );
  });
});
