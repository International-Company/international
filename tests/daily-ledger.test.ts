// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dailyLedger } from '../src/modules/exchange/activity.service.ts';
import { dayKey } from '../src/core/time/day-key.ts';

/**
 * A teller's days, and what he owed the bank at the end of each.
 *
 * The figure that matters is the debt as of each evening: a transfer left
 * unsent yesterday is still owed today, and one sent this morning was still
 * owed last night. Pinned here, because it is the number reconciled against
 * the bank and it must not drift as later transfers are sent.
 */

const UNIT = 100_000_000n;
const HOUR = 3_600_000;

const today = dayKey(new Date());
const yesterday = new Date(today.getTime() - 24 * HOUR);
const at = (day: Date, hours: number) => new Date(day.getTime() + hours * HOUR);

type Transfer = {
  toCurrency: string;
  payoutBankAmount: bigint;
  createdAt: Date;
  transferConfirmedAt: Date | null;
  status: string;
};

type Worked = {
  businessDayId: string;
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency: string;
  payoutCashAmount: bigint;
  payoutBankAmount: bigint;
};

function fakeDb(worked: Worked[], transfers: Transfer[]) {
  const asked: Record<string, unknown>[] = [];
  return {
    asked,
    db: {
      businessDay: {
        findMany: async () => [
          { id: 'd-today', date: today, status: 'OPEN' },
          { id: 'd-yesterday', date: yesterday, status: 'CLOSED' },
        ],
      },
      transaction: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          asked.push(args.where);
          return args.where.type === 'EXCHANGE' ? worked : transfers;
        },
      },
    } as never,
  };
}

const teller = {
  id: 'ahmad',
  name: 'Ahmad',
  branchId: 'main',
  permissions: ['exchange.transaction.view'],
};

describe('a teller’s days', () => {
  it('owes last night what was sent only this morning', async () => {
    const sentThisMorning: Transfer = {
      toCurrency: 'ILS',
      payoutBankAmount: 100n * UNIT,
      createdAt: at(yesterday, 15),
      transferConfirmedAt: at(today, 0.001),
      status: 'POSTED',
    };
    const { db } = fakeDb([], [sentThisMorning]);

    const [todayRow, yesterdayRow] = await dailyLedger({ days: 2 }, teller, db);

    assert.deepEqual(yesterdayRow!.owedAtEnd, [{ currency: 'ILS', amount: 100n * UNIT }]);
    assert.deepEqual(todayRow!.owedAtEnd, [], 'and owes nothing for it once it is sent');
  });

  it('carries yesterday’s unsent transfer into today, alongside today’s', async () => {
    const { db } = fakeDb(
      [],
      [
        {
          toCurrency: 'ILS',
          payoutBankAmount: 100n * UNIT,
          createdAt: at(yesterday, 10),
          transferConfirmedAt: null,
          status: 'PENDING_TRANSFER',
        },
        {
          toCurrency: 'ILS',
          payoutBankAmount: 50n * UNIT,
          createdAt: at(today, 0.0001),
          transferConfirmedAt: null,
          status: 'PENDING_TRANSFER',
        },
      ],
    );

    const [todayRow, yesterdayRow] = await dailyLedger({ days: 2 }, teller, db);

    assert.deepEqual(yesterdayRow!.owedAtEnd, [{ currency: 'ILS', amount: 100n * UNIT }]);
    assert.deepEqual(todayRow!.owedAtEnd, [{ currency: 'ILS', amount: 150n * UNIT }]);
  });

  it('adds up each day’s exchanges on their own day', async () => {
    const { db } = fakeDb(
      [
        {
          businessDayId: 'd-today',
          fromCurrency: 'USD',
          fromAmount: 100n * UNIT,
          toCurrency: 'ILS',
          payoutCashAmount: 300n * UNIT,
          payoutBankAmount: 0n,
        },
        {
          businessDayId: 'd-today',
          fromCurrency: 'USD',
          fromAmount: 50n * UNIT,
          toCurrency: 'ILS',
          payoutCashAmount: 0n,
          payoutBankAmount: 150n * UNIT,
        },
        {
          businessDayId: 'd-yesterday',
          fromCurrency: 'JOD',
          fromAmount: 10n * UNIT,
          toCurrency: 'ILS',
          payoutCashAmount: 45n * UNIT,
          payoutBankAmount: 0n,
        },
      ],
      [],
    );

    const [todayRow, yesterdayRow] = await dailyLedger({ days: 2 }, teller, db);

    assert.equal(todayRow!.count, 2);
    assert.deepEqual(todayRow!.received, [{ currency: 'USD', amount: 150n * UNIT }]);
    assert.deepEqual(todayRow!.paidCash, [{ currency: 'ILS', amount: 300n * UNIT }]);
    assert.deepEqual(todayRow!.paidBank, [{ currency: 'ILS', amount: 150n * UNIT }]);
    assert.equal(yesterdayRow!.count, 1);
    assert.deepEqual(yesterdayRow!.received, [{ currency: 'JOD', amount: 10n * UNIT }]);
  });

  it('is a teller’s own, whoever he names', async () => {
    const { db, asked } = fakeDb([], []);
    await dailyLedger({ days: 2, tellerId: 'sami' }, teller, db);
    assert.ok(asked.every((where) => where.createdById === 'ahmad'));
  });

  it('is the named teller’s for someone who sees everybody’s', async () => {
    const { db, asked } = fakeDb([], []);
    await dailyLedger(
      { days: 2, tellerId: 'sami' },
      {
        ...teller,
        permissions: ['exchange.transaction.view', 'exchange.transaction.viewAll'],
      },
      db,
    );
    assert.ok(asked.every((where) => where.createdById === 'sami'));
  });
});
