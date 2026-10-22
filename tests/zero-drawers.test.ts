// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zeroAll } from '../src/modules/drawers/drawer.service.ts';

/**
 * Resetting every drawer to zero.
 *
 * The act touches every balance at once, so each of its refusals and each of
 * its promises is pinned: only the manager, never without a reason or an open
 * day, never under a shift or a handover still in flight — and when it does
 * run, every drawer ends at exactly zero with a movement saying so, booked as
 * the owner's money so the day's result does not move.
 */

const UNIT = 100_000_000n;

interface FakeDrawer {
  id: string;
  ownerKey: string;
  currencyCode: string;
  kind: string;
  balance: bigint;
  isActive: boolean;
  allowNegative: boolean;
}

function fakeDb(
  drawers: FakeDrawer[],
  options: { day?: boolean; openShifts?: number; pendingHandovers?: number } = {},
) {
  const movements: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];

  const db = {
    businessDay: {
      findFirst: async () => (options.day === false ? null : { id: 'day-1' }),
    },
    shift: { count: async () => options.openShifts ?? 0 },
    handover: { count: async () => options.pendingHandovers ?? 0 },
    drawer: {
      findMany: async () =>
        drawers
          .filter((drawer) => drawer.isActive && drawer.balance !== 0n)
          .map(({ ownerKey, currencyCode, kind, balance }) => ({
            ownerKey,
            currencyCode,
            kind,
            balance,
          })),
      findUnique: async (args: {
        where: {
          ownerKey_currencyCode_kind: { ownerKey: string; currencyCode: string; kind: string };
        };
      }) => {
        const key = args.where.ownerKey_currencyCode_kind;
        return (
          drawers.find(
            (drawer) =>
              drawer.ownerKey === key.ownerKey &&
              drawer.currencyCode === key.currencyCode &&
              drawer.kind === key.kind,
          ) ?? null
        );
      },
      update: async (args: { where: { id: string }; data: { balance: { increment: bigint } } }) => {
        const drawer = drawers.find((entry) => entry.id === args.where.id)!;
        drawer.balance += args.data.balance.increment;
        return { balance: drawer.balance };
      },
    },
    drawerMovement: {
      create: async (args: { data: Record<string, unknown> }) => {
        movements.push(args.data);
        return args.data;
      },
    },
    auditLog: {
      findFirst: async () => null,
      create: async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return args.data;
      },
    },
  };

  return { db: db as never, drawers, movements, audits };
}

const drawer = (patch: Partial<FakeDrawer>): FakeDrawer => ({
  id: `${patch.ownerKey ?? 'TREASURY'}:${patch.currencyCode ?? 'ILS'}:${patch.kind ?? 'CASH'}`,
  ownerKey: 'TREASURY',
  currencyCode: 'ILS',
  kind: 'CASH',
  balance: 0n,
  isActive: true,
  allowNegative: false,
  ...patch,
});

const manager = {
  id: 'boss',
  name: 'Boss',
  branchId: 'main',
  permissions: ['exchange.drawer.manage'],
};

const refusedWith = (key: string) => (error: { messageKey?: string; code?: string }) =>
  error.messageKey === key || error.code === key;

describe('resetting every drawer', () => {
  it('is the manager’s alone', async () => {
    const { db, movements } = fakeDb([drawer({ balance: 100n * UNIT })]);
    await assert.rejects(
      () => zeroAll({ reason: 'new start' }, { ...manager, permissions: [] }, db),
      refusedWith('FORBIDDEN'),
    );
    assert.equal(movements.length, 0);
  });

  it('needs a reason', async () => {
    const { db } = fakeDb([drawer({ balance: 100n * UNIT })]);
    await assert.rejects(
      () => zeroAll({ reason: '  ' }, manager, db),
      refusedWith('VALIDATION_ERROR'),
    );
  });

  it('needs an open day', async () => {
    const { db } = fakeDb([drawer({ balance: 100n * UNIT })], { day: false });
    await assert.rejects(
      () => zeroAll({ reason: 'new start' }, manager, db),
      refusedWith('errors.dayNotOpen'),
    );
  });

  it('waits for every open shift to close', async () => {
    const { db, movements } = fakeDb([drawer({ balance: 100n * UNIT })], { openShifts: 2 });
    await assert.rejects(
      () => zeroAll({ reason: 'new start' }, manager, db),
      refusedWith('errors.zeroOpenShifts'),
    );
    assert.equal(movements.length, 0, 'nothing moved');
  });

  it('waits for every pending handover', async () => {
    const { db } = fakeDb([drawer({ balance: 100n * UNIT })], { pendingHandovers: 1 });
    await assert.rejects(
      () => zeroAll({ reason: 'new start' }, manager, db),
      refusedWith('errors.zeroPendingHandovers'),
    );
  });

  it('takes every drawer to exactly zero, each with a movement on the record', async () => {
    const { db, drawers, movements, audits } = fakeDb([
      drawer({ currencyCode: 'ILS', balance: 1_250n * UNIT }),
      drawer({ currencyCode: 'USD', balance: 0n }),
      drawer({
        currencyCode: 'ILS',
        kind: 'CORRESPONDENT',
        balance: -300n * UNIT,
        allowNegative: true,
      }),
      drawer({ ownerKey: 'teller:ahmad', currencyCode: 'USD', balance: 40n * UNIT }),
    ]);

    const { zeroed } = await zeroAll({ reason: 'new start' }, manager, db);

    assert.ok(
      drawers.every((entry) => entry.balance === 0n),
      'every balance is zero',
    );
    assert.equal(zeroed.length, 3, 'a drawer already at zero is left alone');
    assert.equal(movements.length, 3);
    assert.equal(audits.length, 1, 'one audit line for the whole act');
  });

  it('books it as the owner’s money, so the day’s result does not move', async () => {
    const { db, movements } = fakeDb([
      drawer({ currencyCode: 'ILS', balance: 500n * UNIT }),
      drawer({
        currencyCode: 'ILS',
        kind: 'CORRESPONDENT',
        balance: -300n * UNIT,
        allowNegative: true,
      }),
    ]);

    await zeroAll({ reason: 'new start' }, manager, db);

    const held = movements.find((entry) => entry.direction === 'OUT')!;
    const owed = movements.find((entry) => entry.direction === 'IN')!;

    assert.equal(held.category, 'OWNER_OUT');
    assert.equal(held.amount, 500n * UNIT);
    assert.equal(owed.category, 'OWNER_IN', 'a negative balance is settled by putting money in');
    assert.equal(owed.amount, 300n * UNIT);

    for (const entry of movements) {
      assert.equal(entry.reason, 'FUNDING');
      assert.equal(entry.businessDayId, 'day-1', 'it belongs to the open day');
      assert.equal(entry.createdById, 'boss');
      assert.match(String(entry.note), /new start/, 'the reason is on every movement');
      assert.equal(entry.balanceAfter, 0n);
    }
  });

  it('includes the drawers in the tellers’ hands', async () => {
    const { db, movements } = fakeDb([
      drawer({ ownerKey: 'teller:ahmad', currencyCode: 'USD', balance: 40n * UNIT }),
    ]);
    await zeroAll({ reason: 'new start' }, manager, db);
    assert.equal(movements.length, 1);
  });
});
