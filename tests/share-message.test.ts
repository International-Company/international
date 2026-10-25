// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pendingTransfers, shareable } from '../src/modules/exchange/share.service.ts';

/**
 * The WhatsApp message, in the office's own order:
 *
 *     الرقم
 *     الاسم
 *     اسم المحفظة أو البنك
 *     المبلغ
 *
 * Pinned because it is read by the person who moves the money, line by line,
 * and a line in the wrong place is a transfer to the wrong place.
 */

const UNIT = 100_000_000n;

type Row = {
  id: string;
  reference: string;
  type: string;
  status: string;
  toCurrency: string;
  toAmount: bigint;
  payoutBankAmount: bigint;
  payoutBankChannel: string | null;
  payoutAccount: string | null;
  payoutAddress: string | null;
  counterpartyName: string | null;
  counterpartyPhone: string | null;
  customer: { fullNameAr: string; fullNameEn: string; phone: string | null } | null;
  payoutWallet: { network: string } | null;
};

const row = (patch: Partial<Row> = {}): Row => ({
  id: 't1',
  reference: 'TXN-20261022-00001',
  type: 'USDT_RECEIVE',
  status: 'PENDING_TRANSFER',
  toCurrency: 'ILS',
  toAmount: 320n * UNIT,
  payoutBankAmount: 320n * UNIT,
  payoutBankChannel: 'بال باي',
  payoutAccount: '0592946938',
  payoutAddress: null,
  counterpartyName: 'احمد عمر',
  counterpartyPhone: '0599000000',
  customer: null,
  payoutWallet: null,
  ...patch,
});

function fakeDb(rows: Row[]) {
  const asked: { where: Record<string, unknown> }[] = [];
  return {
    asked,
    db: {
      transaction: {
        findUnique: async () => rows[0] ?? null,
        findMany: async (args: { where: Record<string, unknown> }) => {
          asked.push(args);
          return rows;
        },
      },
      currency: {
        findMany: async () => [
          { code: 'ILS', nameAr: 'شيكل إسرائيلي', nameEn: 'Israeli Shekel' },
          { code: 'USD', nameAr: 'دولار أمريكي', nameEn: 'US Dollar' },
        ],
      },
      systemSetting: { findMany: async () => [] },
    } as never,
  };
}

const lines = (text: string) => text.split('\n').filter((line) => line.trim());

describe('one transfer, as the office writes it', () => {
  it('is number, name, wallet or bank, amount — in that order', async () => {
    const { db } = fakeDb([row()]);
    const { text } = await shareable('t1', 'ar', db);
    assert.deepEqual(lines(text), ['0592946938', 'احمد عمر', 'بال باي', '320 شيكل']);
  });

  it('puts a blank line between each, the way they are typed', async () => {
    const { db } = fakeDb([row()]);
    const { text } = await shareable('t1', 'ar', db);
    assert.equal(text, '0592946938\n\nاحمد عمر\n\nبال باي\n\n320 شيكل');
  });

  it('uses the phone when no account was recorded', async () => {
    const { db } = fakeDb([row({ payoutAccount: null })]);
    assert.equal(lines((await shareable('t1', 'ar', db)).text)[0], '0599000000');
  });

  it('takes a registered customer’s name and phone over anything typed', async () => {
    const { db } = fakeDb([
      row({
        payoutAccount: null,
        customer: { fullNameAr: 'سامي', fullNameEn: 'Sami', phone: '0597111111' },
      }),
    ]);
    const text = (await shareable('t1', 'ar', db)).text;
    assert.deepEqual(lines(text).slice(0, 2), ['0597111111', 'سامي']);
  });

  it('says only what reaches the person by transfer when part was paid in cash', async () => {
    const { db } = fakeDb([row({ toAmount: 500n * UNIT, payoutBankAmount: 200n * UNIT })]);
    assert.equal(lines((await shareable('t1', 'ar', db)).text).at(-1), '200 شيكل');
  });

  it('leaves out the channel of a cash trade rather than a blank line', async () => {
    const { db } = fakeDb([
      row({ status: 'POSTED', payoutBankAmount: 0n, payoutBankChannel: null, payoutAccount: null }),
    ]);
    assert.deepEqual(lines((await shareable('t1', 'ar', db)).text), [
      '0599000000',
      'احمد عمر',
      '320 شيكل',
    ]);
  });

  it('keeps a fraction that is really there', async () => {
    const { db } = fakeDb([row({ payoutBankAmount: 32050n * 1_000_000n })]);
    assert.equal(lines((await shareable('t1', 'ar', db)).text).at(-1), '320.50 شيكل');
  });
});

describe('every pending transfer, as one message', () => {
  const teller = {
    id: 'ahmad',
    name: 'A',
    branchId: 'main',
    permissions: ['exchange.receipt.print'],
  };

  it('is each transfer in the same four lines, divided', async () => {
    const { db } = fakeDb([
      row(),
      row({
        id: 't2',
        payoutAccount: '0597222222',
        counterpartyName: 'سامي',
        payoutBankAmount: 100n * UNIT,
      }),
    ]);

    const result = await pendingTransfers(teller, 'ar', db);

    assert.equal(result.count, 2);
    const blocks = result.text.split('———').map(lines);
    assert.deepEqual(blocks[0], ['0592946938', 'احمد عمر', 'بال باي', '320 شيكل']);
    assert.deepEqual(blocks[1], ['0597222222', 'سامي', 'بال باي', '100 شيكل']);
  });

  it('asks only for what is still owed by transfer, and for a teller only his own', async () => {
    const { db, asked } = fakeDb([]);
    await pendingTransfers(teller, 'ar', db);
    const where = asked[0]!.where;

    assert.equal(where.status, 'PENDING_TRANSFER');
    assert.deepEqual(where.payoutBankAmount, { gt: 0n });
    assert.equal(where.createdById, 'ahmad');
  });

  it('gives the office’s to someone who sees everybody’s', async () => {
    const { db, asked } = fakeDb([]);
    await pendingTransfers(
      { ...teller, permissions: ['exchange.receipt.print', 'exchange.transaction.viewAll'] },
      'ar',
      db,
    );
    assert.equal(asked[0]!.where.createdById, undefined);
  });

  it('asks only for its own kind — exchange apart from USDT', async () => {
    const { db, asked } = fakeDb([]);
    await pendingTransfers(teller, 'ar', db, 'exchange');
    await pendingTransfers(teller, 'ar', db, 'usdt');
    assert.deepEqual(asked[0]!.where.type, { in: ['EXCHANGE', 'WALLET_CASHOUT', 'WALLET_TOPUP'] });
    assert.deepEqual(asked[1]!.where.type, { in: ['USDT_RECEIVE', 'USDT_SEND'] });
  });

  it('says there is nothing rather than sending an empty message', async () => {
    const { db } = fakeDb([]);
    assert.deepEqual(await pendingTransfers(teller, 'ar', db), { count: 0, text: '' });
  });
});
