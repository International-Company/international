// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { preview, record } from '../src/modules/treasury/till-count.service.ts';

/**
 * جرد الصندوق: a teller counted against what they traded, with no float.
 *
 * Pinned: expected = opening + received − paid + top-ups − draws, per
 * currency; the opening carries from what the last count left with them and
 * only a first count may type its own; the count needs a second person, a
 * teller off shift, and every currency the books know about.
 */

const UNIT = 100_000_000n;

interface Options {
  movements?: {
    currency: string;
    direction: 'IN' | 'OUT';
    amount: bigint;
    transactionId: string;
  }[];
  adjustments?: { currencyCode: string; direction: 'IN' | 'OUT'; amount: bigint }[];
  previous?: { currencyCode: string; kept: bigint }[] | null;
  onShift?: boolean;
}

function fakeDb(options: Options = {}) {
  const created: { counts: unknown[]; discrepancies: unknown[] } = {
    counts: [],
    discrepancies: [],
  };
  const db = {
    user: {
      findUnique: async () => ({
        id: 'ahmad',
        fullNameEn: 'Ahmad',
        fullNameAr: 'أحمد',
        branchId: 'b1',
      }),
    },
    tillCount: {
      findFirst: async () =>
        options.previous
          ? {
              reference: 'CNT-1',
              createdAt: new Date('2026-10-24T18:00:00Z'),
              periodEnd: new Date('2026-10-24T18:00:00Z'),
              lines: options.previous,
            }
          : null,
      create: async ({ data }: { data: { lines: { create: unknown[] } } }) => {
        created.counts.push(data);
        return { id: 'c1', ...data, lines: data.lines.create };
      },
    },
    businessDay: {
      findFirst: async () => ({
        id: 'd1',
        status: 'OPEN',
        openedAt: new Date('2026-10-25T05:00:00Z'),
        date: new Date('2026-10-25T00:00:00Z'),
      }),
    },
    drawerMovement: {
      findMany: async () =>
        (options.movements ?? []).map((movement) => ({
          direction: movement.direction,
          amount: movement.amount,
          transactionId: movement.transactionId,
          drawer: { currencyCode: movement.currency },
        })),
    },
    tillAdjustment: { findMany: async () => options.adjustments ?? [] },
    shift: { findFirst: async () => (options.onShift ? { id: 's1' } : null) },
    sequence: { upsert: async () => ({ value: 1 }) },
    discrepancy: {
      create: async ({ data }: { data: unknown }) => {
        created.discrepancies.push(data);
        return data;
      },
    },
    auditLog: { findFirst: async () => null, create: async () => ({}) },
  };
  return { db: db as never, created };
}

const manager = {
  id: 'boss',
  name: 'Boss',
  permissions: ['treasury.handover.manage'],
  branchId: 'b1',
};

describe('what a teller should hold', () => {
  it('is opening plus received, less paid, plus top-ups, less draws', async () => {
    const { db } = fakeDb({
      previous: [{ currencyCode: 'ILS', kept: 500n * UNIT }],
      movements: [
        { currency: 'ILS', direction: 'IN', amount: 3_200n * UNIT, transactionId: 't1' },
        { currency: 'USD', direction: 'OUT', amount: 1_000n * UNIT, transactionId: 't1' },
        { currency: 'USD', direction: 'IN', amount: 400n * UNIT, transactionId: 't2' },
        { currency: 'ILS', direction: 'OUT', amount: 1_290n * UNIT, transactionId: 't2' },
      ],
      adjustments: [
        { currencyCode: 'USD', direction: 'IN', amount: 2_000n * UNIT },
        { currencyCode: 'ILS', direction: 'OUT', amount: 1_000n * UNIT },
      ],
    });

    const books = await preview('ahmad', manager, db);
    const ils = books.lines.find((line) => line.currency === 'ILS');
    const usd = books.lines.find((line) => line.currency === 'USD');

    assert.equal(books.deals, 2);
    assert.equal(ils?.expected, (500n + 3_200n - 1_290n - 1_000n) * UNIT);
    assert.equal(usd?.expected, (400n - 1_000n + 2_000n) * UNIT);
  });

  it('starts from what the last count left with them', async () => {
    const { db } = fakeDb({ previous: [{ currencyCode: 'JOD', kept: 70n * UNIT }] });
    const books = await preview('ahmad', manager, db);
    assert.equal(books.previous?.reference, 'CNT-1');
    assert.equal(books.lines[0]?.expected, 70n * UNIT);
  });

  it('is for someone who counts', async () => {
    const { db } = fakeDb();
    await assert.rejects(
      () => preview('ahmad', { id: 'sami', name: 'Sami', permissions: [] }, db),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
  });
});

describe('a till count', () => {
  it('records an exact count, keeping all of it with the teller by default', async () => {
    const { db, created } = fakeDb({
      movements: [{ currency: 'ILS', direction: 'IN', amount: 900n * UNIT, transactionId: 't1' }],
    });

    await record(
      { tellerId: 'ahmad', lines: [{ currency: 'ILS', counted: 900n * UNIT }] },
      manager,
      db,
    );

    const saved = created.counts[0] as {
      lines: { create: { kept: bigint; difference: bigint }[] };
    };
    assert.equal(saved.lines.create[0]?.difference, 0n);
    assert.equal(saved.lines.create[0]?.kept, 900n * UNIT);
    assert.equal(created.discrepancies.length, 0);
  });

  it('lets a first count say what the teller started with', async () => {
    const { db, created } = fakeDb({
      movements: [{ currency: 'ILS', direction: 'IN', amount: 100n * UNIT, transactionId: 't1' }],
    });
    await record(
      {
        tellerId: 'ahmad',
        lines: [{ currency: 'ILS', counted: 600n * UNIT, opening: 500n * UNIT, kept: 0n }],
      },
      manager,
      db,
    );
    const saved = created.counts[0] as { lines: { create: { expected: bigint; kept: bigint }[] } };
    assert.equal(saved.lines.create[0]?.expected, 600n * UNIT);
    assert.equal(saved.lines.create[0]?.kept, 0n);
  });

  it('ignores a typed opening once there is a count to carry from', async () => {
    const { db, created } = fakeDb({ previous: [{ currencyCode: 'ILS', kept: 200n * UNIT }] });
    await record(
      {
        tellerId: 'ahmad',
        lines: [{ currency: 'ILS', counted: 200n * UNIT, opening: 9_999n * UNIT }],
      },
      manager,
      db,
    );
    const saved = created.counts[0] as {
      lines: { create: { opening: bigint; difference: bigint }[] };
    };
    assert.equal(saved.lines.create[0]?.opening, 200n * UNIT);
    assert.equal(saved.lines.create[0]?.difference, 0n);
  });

  it('refuses a currency the books know about left uncounted', async () => {
    const { db } = fakeDb({
      movements: [
        { currency: 'ILS', direction: 'IN', amount: 100n * UNIT, transactionId: 't1' },
        { currency: 'USD', direction: 'OUT', amount: 30n * UNIT, transactionId: 't1' },
      ],
    });
    await assert.rejects(() =>
      record(
        { tellerId: 'ahmad', lines: [{ currency: 'ILS', counted: 100n * UNIT }] },
        manager,
        db,
      ),
    );
  });

  it('is never one’s own', async () => {
    const { db } = fakeDb();
    await assert.rejects(
      () => record({ tellerId: 'boss', lines: [{ currency: 'ILS', counted: 0n }] }, manager, db),
      (error: { messageKey?: string }) => error.messageKey === 'errors.countOwnTill',
    );
  });

  it('leaves a teller on a shift to the handover', async () => {
    const { db } = fakeDb({ onShift: true });
    await assert.rejects(
      () => record({ tellerId: 'ahmad', lines: [{ currency: 'ILS', counted: 0n }] }, manager, db),
      (error: { messageKey?: string }) => error.messageKey === 'errors.tillOnShift',
    );
  });
});
