// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zeroAll, zeroLocks } from '../src/modules/drawers/drawer.service.ts';
import { invalidateSettingsCache } from '../src/modules/settings/settings.service.ts';

/**
 * Resetting the drawers the manager chose to zero.
 *
 * The act can touch every balance at once, so each of its refusals and each of
 * its promises is pinned: only the manager, never without a reason, a choice or
 * an open day, never a drawer whose teller is mid-shift or mid-handover — and
 * when it runs, every chosen drawer ends at exactly zero with a movement saying
 * so, booked as the owner's money so the day's result does not move, while the
 * drawers left unticked are not touched at all.
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

type Where = {
  id?: { in: string[] };
  ownerKey?: { in: string[] };
  isActive?: boolean;
  balance?: { not: bigint };
};

function fakeDb(
  drawers: FakeDrawer[],
  options: { day?: boolean; openShiftsFor?: string[]; pendingHandoversFor?: string[] } = {},
) {
  const movements: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];

  const matches = (drawer: FakeDrawer, where: Where) =>
    (!where.id || where.id.in.includes(drawer.id)) &&
    (!where.ownerKey || where.ownerKey.in.includes(drawer.ownerKey)) &&
    (where.isActive === undefined || drawer.isActive === where.isActive) &&
    (!where.balance || drawer.balance !== where.balance.not);

  const db = {
    businessDay: {
      findFirst: async () => (options.day === false ? null : { id: 'day-1' }),
    },
    // The office runs its days by hand in these tests, so "no day" means no day.
    systemSetting: {
      findMany: async () => [{ key: 'day.automatic', value: 'false' }],
    },
    shift: {
      findMany: async () => (options.openShiftsFor ?? []).map((tellerId) => ({ tellerId })),
    },
    handover: {
      findMany: async () => (options.pendingHandoversFor ?? []).map((tellerId) => ({ tellerId })),
    },
    drawer: {
      findMany: async (args: { where: Where }) =>
        drawers
          .filter((drawer) => matches(drawer, args.where))
          .map(({ id, ownerKey, currencyCode, kind, balance }) => ({
            id,
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

const all = (list: FakeDrawer[]) => list.map((entry) => entry.id);

describe('resetting the chosen drawers', () => {
  it('is the manager’s alone', async () => {
    const list = [drawer({ balance: 100n * UNIT })];
    const { db, movements } = fakeDb(list);
    await assert.rejects(
      () =>
        zeroAll({ reason: 'new start', drawerIds: all(list) }, { ...manager, permissions: [] }, db),
      refusedWith('FORBIDDEN'),
    );
    assert.equal(movements.length, 0);
  });

  it('needs a reason', async () => {
    const list = [drawer({ balance: 100n * UNIT })];
    const { db } = fakeDb(list);
    await assert.rejects(
      () => zeroAll({ reason: '  ', drawerIds: all(list) }, manager, db),
      refusedWith('VALIDATION_ERROR'),
    );
  });

  it('needs at least one drawer chosen', async () => {
    const { db } = fakeDb([drawer({ balance: 100n * UNIT })]);
    await assert.rejects(
      () => zeroAll({ reason: 'new start', drawerIds: [] }, manager, db),
      refusedWith('VALIDATION_ERROR'),
    );
  });

  it('needs an open day, when the office opens its days by hand', async () => {
    invalidateSettingsCache();
    const list = [drawer({ balance: 100n * UNIT })];
    const { db } = fakeDb(list, { day: false });
    await assert.rejects(
      () => zeroAll({ reason: 'new start', drawerIds: all(list) }, manager, db),
      refusedWith('errors.dayNotOpen'),
    );
  });

  it('touches only the drawers that were ticked', async () => {
    const kept = drawer({ currencyCode: 'USD', balance: 70n * UNIT });
    const cleared = drawer({ currencyCode: 'ILS', balance: 500n * UNIT });
    const { db, movements } = fakeDb([kept, cleared]);

    await zeroAll({ reason: 'new start', drawerIds: [cleared.id] }, manager, db);

    assert.equal(cleared.balance, 0n);
    assert.equal(kept.balance, 70n * UNIT, 'an unticked drawer keeps every unit');
    assert.equal(movements.length, 1);
  });

  it('takes every chosen drawer to exactly zero, each with a movement on the record', async () => {
    const list = [
      drawer({ currencyCode: 'ILS', balance: 1_250n * UNIT }),
      drawer({ currencyCode: 'USD', balance: 0n }),
      drawer({
        currencyCode: 'ILS',
        kind: 'CORRESPONDENT',
        balance: -300n * UNIT,
        allowNegative: true,
      }),
      drawer({ ownerKey: 'teller:ahmad', currencyCode: 'USD', balance: 40n * UNIT }),
    ];
    const { db, drawers, movements, audits } = fakeDb(list);

    const { zeroed } = await zeroAll({ reason: 'new start', drawerIds: all(list) }, manager, db);

    assert.ok(
      drawers.every((entry) => entry.balance === 0n),
      'every balance is zero',
    );
    assert.equal(zeroed.length, 3, 'a drawer already at zero is left alone');
    assert.equal(movements.length, 3);
    assert.equal(audits.length, 1, 'one audit line for the whole act');
  });

  it('books it as the owner’s money, so the day’s result does not move', async () => {
    const list = [
      drawer({ currencyCode: 'ILS', balance: 500n * UNIT }),
      drawer({
        currencyCode: 'ILS',
        kind: 'CORRESPONDENT',
        balance: -300n * UNIT,
        allowNegative: true,
      }),
    ];
    const { db, movements } = fakeDb(list);

    await zeroAll({ reason: 'new start', drawerIds: all(list) }, manager, db);

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
});

describe('drawers whose money is in flight', () => {
  const treasury = () => drawer({ currencyCode: 'ILS', balance: 900n * UNIT });
  const ahmads = () =>
    drawer({ ownerKey: 'teller:ahmad', currencyCode: 'USD', balance: 40n * UNIT });

  it('names a mid-shift teller’s drawers, and only his', async () => {
    const list = [treasury(), ahmads()];
    const { db } = fakeDb(list, { openShiftsFor: ['ahmad'] });

    const locks = await zeroLocks(db);

    assert.equal(locks.get('teller:ahmad:USD:CASH'), 'OPEN_SHIFT');
    assert.equal(locks.has('TREASURY:ILS:CASH'), false, 'the treasury is not his');
  });

  it('names a teller with a handover still pending', async () => {
    const { db } = fakeDb([ahmads()], { pendingHandoversFor: ['ahmad'] });
    assert.equal((await zeroLocks(db)).get('teller:ahmad:USD:CASH'), 'PENDING_HANDOVER');
  });

  it('refuses a locked drawer even when it is asked for', async () => {
    const list = [treasury(), ahmads()];
    const { db, movements } = fakeDb(list, { openShiftsFor: ['ahmad'] });

    await assert.rejects(
      () => zeroAll({ reason: 'new start', drawerIds: all(list) }, manager, db),
      refusedWith('errors.zeroLocked'),
    );
    assert.equal(movements.length, 0, 'nothing moved — not even the drawers that were allowed');
  });

  it('still resets everything else while one teller is at the counter', async () => {
    const office = treasury();
    const his = ahmads();
    const { db } = fakeDb([office, his], { openShiftsFor: ['ahmad'] });

    await zeroAll({ reason: 'new start', drawerIds: [office.id] }, manager, db);

    assert.equal(office.balance, 0n);
    assert.equal(his.balance, 40n * UNIT, 'his float is exactly what he was handed');
  });
});
