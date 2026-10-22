// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { machineToday } from '../src/modules/exchange/activity.service.ts';

/**
 * The machine's running total for the teller standing at it.
 *
 * Pinned: whose and which day it reads, and how it splits what was paid — the
 * cash across the counter apart from the transfers, and the transfers by the
 * channel they go through and by whether they have been sent.
 */

const UNIT = 100_000_000n;

type Row = {
  status: string;
  fromCurrency: string;
  fromAmount: bigint;
  toCurrency: string;
  payoutCashAmount: bigint;
  payoutBankAmount: bigint;
  payoutBankChannel: string | null;
};

const row = (patch: Partial<Row>): Row => ({
  status: 'POSTED',
  fromCurrency: 'USD',
  fromAmount: 100n * UNIT,
  toCurrency: 'ILS',
  payoutCashAmount: 290n * UNIT,
  payoutBankAmount: 0n,
  payoutBankChannel: null,
  ...patch,
});

function fakeDb(rows: Row[], options: { day?: boolean } = {}) {
  const asked: { where: Record<string, unknown> }[] = [];
  return {
    asked,
    db: {
      businessDay: {
        findFirst: async () => (options.day === false ? null : { id: 'day-1' }),
      },
      transaction: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          asked.push(args);
          return rows;
        },
      },
    } as never,
  };
}

const teller = {
  id: 'ahmad',
  name: 'Ahmad',
  branchId: 'main',
  permissions: ['exchange.machine.use'],
};

describe('the machine’s total for today', () => {
  it('says so when no day is open, rather than showing zeroes as if it were', async () => {
    const { db } = fakeDb([row({})], { day: false });
    const today = await machineToday(teller, db);
    assert.equal(today.dayOpen, false);
    assert.equal(today.count, 0);
  });

  it('reads his own exchanges in the open day, and nothing reversed', async () => {
    const { db, asked } = fakeDb([]);
    await machineToday(teller, db);
    const where = asked[0]!.where;

    assert.equal(where.createdById, 'ahmad');
    assert.equal(where.businessDayId, 'day-1');
    assert.equal(where.type, 'EXCHANGE');
    assert.equal(where.reversalOfId, null);
    assert.deepEqual(where.status, { in: ['POSTED', 'PENDING_TRANSFER'] });
  });

  it('keeps the cash across the counter apart from the transfers', async () => {
    const { db } = fakeDb([
      row({ payoutCashAmount: 290n * UNIT }),
      row({
        payoutCashAmount: 90n * UNIT,
        payoutBankAmount: 200n * UNIT,
        payoutBankChannel: 'PalPay',
        status: 'PENDING_TRANSFER',
      }),
    ]);

    const today = await machineToday(teller, db);

    assert.equal(today.count, 2);
    assert.deepEqual(today.received, [{ currency: 'USD', amount: 200n * UNIT }]);
    assert.deepEqual(today.paidCash, [{ currency: 'ILS', amount: 380n * UNIT }]);
    assert.deepEqual(today.paidBank, [{ currency: 'ILS', amount: 200n * UNIT }]);
  });

  it('splits the transfers by channel, and by whether they have been sent', async () => {
    const { db } = fakeDb([
      row({
        payoutCashAmount: 0n,
        payoutBankAmount: 300n * UNIT,
        payoutBankChannel: 'PalPay',
        status: 'PENDING_TRANSFER',
      }),
      row({
        payoutCashAmount: 0n,
        payoutBankAmount: 120n * UNIT,
        payoutBankChannel: 'PalPay',
        status: 'POSTED',
      }),
      row({
        payoutCashAmount: 0n,
        payoutBankAmount: 50n * UNIT,
        payoutBankChannel: 'Jawwal Pay',
        status: 'PENDING_TRANSFER',
      }),
    ]);

    const { bank } = await machineToday(teller, db);
    const palpay = bank.find((entry) => entry.channel === 'PalPay')!;

    assert.equal(palpay.pending, 300n * UNIT);
    assert.equal(palpay.pendingCount, 1);
    assert.equal(palpay.sent, 120n * UNIT);
    assert.equal(palpay.sentCount, 1);
    assert.equal(bank[0]?.channel, 'PalPay', 'the most owed comes first');
    assert.equal(bank.length, 2);
  });

  it('counts a transfer with no channel recorded, under a name that says so', async () => {
    const { db } = fakeDb([
      row({
        payoutCashAmount: 0n,
        payoutBankAmount: 10n * UNIT,
        payoutBankChannel: null,
        status: 'PENDING_TRANSFER',
      }),
    ]);
    const { bank } = await machineToday(teller, db);
    assert.equal(bank[0]?.channel, '—');
    assert.equal(bank[0]?.pending, 10n * UNIT);
  });
});
