// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { currentOpenDay, requireOpenDay } from '../src/modules/exchange/business-day.service.ts';
import { invalidateSettingsCache } from '../src/modules/settings/settings.service.ts';

/**
 * The automatic business day.
 *
 * The office chose not to open and close days by hand, so recording must never
 * stop for want of one: a missing day opens with the first operation, and a
 * closed day reopens when somebody records into it — each on the audit log.
 * With the setting off, the old refusals stand.
 */

type Day = { id: string; branchId: string; date: Date; status: string; openedById?: string };

function fakeDb(options: { days?: Day[]; automatic?: boolean; systemUser?: boolean } = {}) {
  const days = [...(options.days ?? [])];
  const audits: Record<string, unknown>[] = [];

  const db = {
    systemSetting: {
      findMany: async () => [{ key: 'day.automatic', value: String(options.automatic ?? true) }],
    },
    user: {
      findFirst: async () => (options.systemUser === false ? null : { id: 'system' }),
    },
    businessDay: {
      findUnique: async (args: { where: { branchId_date: { branchId: string; date: Date } } }) =>
        days.find(
          (day) =>
            day.branchId === args.where.branchId_date.branchId &&
            day.date.getTime() === args.where.branchId_date.date.getTime(),
        ) ?? null,
      findFirst: async () =>
        days.filter((day) => day.status === 'OPEN' || day.status === 'REOPENED').at(-1) ?? null,
      upsert: async (args: { create: Omit<Day, 'id'> }) => {
        const day = { id: `day-${days.length + 1}`, ...args.create };
        days.push(day);
        return day;
      },
      update: async (args: { where: { id: string }; data: Partial<Day> }) => {
        const day = days.find((entry) => entry.id === args.where.id)!;
        Object.assign(day, args.data);
        return day;
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

  return { db: db as never, days, audits };
}

const teller = { id: 'ahmad', name: 'Ahmad' };
const today = new Date();
const midnight = () => {
  const local = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return local;
};

beforeEach(() => invalidateSettingsCache());

describe('with the automatic day on', () => {
  it('opens today with the first operation, credited to whoever made it', async () => {
    const { db, days, audits } = fakeDb();

    const day = await requireOpenDay('main', today, db, teller);

    assert.equal(day.status, 'OPEN');
    assert.equal(days.length, 1);
    assert.equal(days[0]!.openedById, 'ahmad');
    assert.equal(audits.length, 1, 'the automatic open is on the audit log');
    assert.equal(audits[0]!.action, 'DAY_OPEN');
  });

  it('reopens a day that was closed, rather than stopping the counter', async () => {
    const { db, days, audits } = fakeDb({
      days: [{ id: 'd1', branchId: 'main', date: midnight(), status: 'CLOSED' }],
    });
    // The fake keys days by the exact instant; the service keys them by day.
    days[0]!.date = (await import('../src/core/time/day-key.ts')).dayKey(today);

    const day = await requireOpenDay('main', today, db, teller);

    assert.equal(day.status, 'REOPENED');
    assert.equal(audits[0]!.action, 'DAY_REOPEN', 'and that it was reopened is on the log');
  });

  it('leaves an open day as it is, and writes nothing', async () => {
    const { dayKey } = await import('../src/core/time/day-key.ts');
    const { db, audits } = fakeDb({
      days: [{ id: 'd1', branchId: 'main', date: dayKey(today), status: 'OPEN' }],
    });

    const day = await requireOpenDay('main', today, db, teller);

    assert.equal(day.id, 'd1');
    assert.equal(audits.length, 0);
  });

  it('opens one under the system account when nobody is at hand', async () => {
    const { db, days } = fakeDb();
    await currentOpenDay('main', db);
    assert.equal(days[0]!.openedById, 'system');
  });
});

describe('with the automatic day off', () => {
  it('refuses to record into a day nobody opened', async () => {
    const { db, days } = fakeDb({ automatic: false });
    await assert.rejects(
      () => requireOpenDay('main', today, db, teller),
      (error: { messageKey?: string }) => error.messageKey === 'errors.dayNotOpen',
    );
    assert.equal(days.length, 0, 'and opens nothing');
  });

  it('refuses a closed day', async () => {
    const { dayKey } = await import('../src/core/time/day-key.ts');
    const { db } = fakeDb({
      automatic: false,
      days: [{ id: 'd1', branchId: 'main', date: dayKey(today), status: 'CLOSED' }],
    });
    await assert.rejects(() => requireOpenDay('main', today, db, teller));
  });
});
