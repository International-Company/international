// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recognise, recognitionKey, remember } from '../src/modules/usdt/recognition.service.ts';

/**
 * Knowing who sent the coins.
 *
 * Pinned: an address seen for one customer brings that customer and their
 * default payout; an address seen for two brings nobody — it is shared, and a
 * guess there hands one person's money to another; and what a settlement
 * teaches is written so the next one can use it.
 */

type WalletRow = {
  network: string;
  address: string;
  timesSeen: number;
  customer: {
    id: string;
    code: string;
    fullNameEn: string;
    fullNameAr: string;
    phone: string | null;
    isBlocked: boolean;
    payouts: {
      id: string;
      channel: string;
      account: string;
      isDefault: boolean;
      timesUsed: number;
    }[];
  };
};

const ahmad = (overrides: Partial<WalletRow> = {}): WalletRow => ({
  network: 'TRON',
  address: 'TSenderAhmad',
  timesSeen: 3,
  customer: {
    id: 'c-ahmad',
    code: 'CUS-000001',
    fullNameEn: 'Ahmad Omar',
    fullNameAr: 'أحمد عمر',
    phone: '0592946938',
    isBlocked: false,
    payouts: [
      { id: 'p1', channel: 'PalPay', account: '0592946938', isDefault: true, timesUsed: 3 },
    ],
  },
  ...overrides,
});

function readDb(rows: WalletRow[]) {
  let queries = 0;
  return {
    queries: () => queries,
    db: {
      customerWallet: {
        findMany: async (args: { where: { OR: { network: string; address: string }[] } }) => {
          queries += 1;
          return rows.filter((row) =>
            args.where.OR.some(
              (want) => want.network === row.network && want.address === row.address,
            ),
          );
        },
      },
    } as never,
  };
}

describe('recognising a sender', () => {
  it('brings the one customer seen on an address, with where they are paid', async () => {
    const { db } = readDb([ahmad()]);
    const known = await recognise([{ network: 'TRON', address: 'TSenderAhmad' }], db);
    const hit = known.get(recognitionKey('TRON', 'TSenderAhmad'));

    assert.equal(hit?.status, 'KNOWN');
    if (hit?.status !== 'KNOWN') return;
    assert.equal(hit.customer.fullNameAr, 'أحمد عمر');
    assert.equal(hit.timesSeen, 3);
    assert.equal(hit.payout?.channel, 'PalPay');
    assert.equal(hit.payout?.account, '0592946938');
  });

  it('calls an address shared once a second customer is seen on it, and names nobody', async () => {
    const sami = ahmad({
      customer: { ...ahmad().customer, id: 'c-sami', fullNameAr: 'سامي', payouts: [] },
    });
    const { db } = readDb([ahmad(), sami]);
    const hit = (await recognise([{ network: 'TRON', address: 'TSenderAhmad' }], db)).get(
      recognitionKey('TRON', 'TSenderAhmad'),
    );

    assert.deepEqual(hit, { status: 'SHARED', customers: 2 });
  });

  it('knows nothing about an address it has never settled', async () => {
    const { db } = readDb([ahmad()]);
    const known = await recognise([{ network: 'TRON', address: 'TSomeoneNew' }], db);
    assert.equal(known.size, 0);
  });

  it('keeps networks apart: the same text on another chain is another address', async () => {
    const { db } = readDb([ahmad()]);
    const known = await recognise([{ network: 'ETHEREUM', address: 'TSenderAhmad' }], db);
    assert.equal(known.size, 0);
  });

  it('asks nothing when there is no sender to ask about', async () => {
    const { db, queries } = readDb([]);
    await recognise([{ network: 'TRON', address: '' }], db);
    assert.equal(queries(), 0);
  });
});

describe('remembering what a settlement taught', () => {
  function writeDb() {
    const calls: { model: string; op: string; args: Record<string, unknown> }[] = [];
    const record = (model: string, op: string) => async (args: Record<string, unknown>) => {
      calls.push({ model, op, args });
      return {};
    };
    return {
      calls,
      db: {
        customerWallet: { upsert: record('customerWallet', 'upsert') },
        customerPayout: {
          updateMany: record('customerPayout', 'updateMany'),
          upsert: record('customerPayout', 'upsert'),
        },
      } as never,
    };
  }

  it('writes the address against the customer, counting each time it is seen', async () => {
    const { db, calls } = writeDb();
    await remember(
      { customerId: 'c-ahmad', network: 'TRON', address: 'TSenderAhmad', payout: null },
      db,
    );

    const wallet = calls.find((call) => call.model === 'customerWallet')!;
    assert.deepEqual(wallet.args.create, {
      customerId: 'c-ahmad',
      network: 'TRON',
      address: 'TSenderAhmad',
    });
    assert.deepEqual((wallet.args.update as { timesSeen: unknown }).timesSeen, { increment: 1 });
    assert.equal(
      calls.some((call) => call.model === 'customerPayout'),
      false,
      'cash teaches no account',
    );
  });

  it('makes the account just used the default, and only that one', async () => {
    const { db, calls } = writeDb();
    await remember(
      {
        customerId: 'c-ahmad',
        network: 'TRON',
        address: 'TSenderAhmad',
        payout: { channel: ' PalPay ', account: ' 0592946938 ' },
      },
      db,
    );

    const cleared = calls.find((call) => call.op === 'updateMany')!;
    const set = calls.find((call) => call.model === 'customerPayout' && call.op === 'upsert')!;

    assert.deepEqual(cleared.args.data, { isDefault: false }, 'the old default is cleared first');
    assert.equal(calls.indexOf(cleared) < calls.indexOf(set), true);
    assert.deepEqual((set.args.create as Record<string, unknown>).isDefault, true);
    assert.deepEqual(
      (set.args.where as { customerId_channel_account: unknown }).customerId_channel_account,
      { customerId: 'c-ahmad', channel: 'PalPay', account: '0592946938' },
      'trimmed, so the same account typed twice is one account',
    );
  });

  it('learns no address from a transfer that carried none', async () => {
    const { db, calls } = writeDb();
    await remember({ customerId: 'c-ahmad', network: 'TRON', address: null, payout: null }, db);
    assert.equal(calls.length, 0);
  });
});
