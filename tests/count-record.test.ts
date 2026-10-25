// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countRecord } from '../src/modules/treasury/count-record.service.ts';

/**
 * محضر الجرد: the books, the declaration and the count, per currency.
 *
 * Pinned: while a handover waits, the books' figure is the teller's drawer as
 * it stands; once confirmed, it is rebuilt as counted plus the gap the close
 * booked — so a shortage reads as one, and a clean count reads as clean. And
 * it is read only by the teller it is about or by someone who counts.
 */

const UNIT = 100_000_000n;

type Line = {
  currencyCode: string;
  kind: string;
  nature: string;
  amount: bigint;
  countedAmount: bigint | null;
};

function fakeDb(options: {
  status: string;
  lines: Line[];
  drawerBalances?: Record<string, bigint>;
  gaps?: { currencyCode: string; amount: bigint }[];
}) {
  return {
    handover: {
      findUnique: async () => ({
        id: 'h1',
        reference: 'HND-1',
        direction: 'TO_TREASURY',
        status: options.status,
        tellerId: 'ahmad',
        createdAt: new Date(),
        confirmedAt: options.status === 'CONFIRMED' ? new Date() : null,
        lines: options.lines,
        teller: { id: 'ahmad', fullNameEn: 'Ahmad', fullNameAr: 'أحمد' },
        createdBy: { fullNameEn: 'Ahmad', fullNameAr: 'أحمد' },
        confirmedBy: null,
      }),
    },
    shift: {
      findFirst: async () => ({ reference: 'SHF-1', discrepancies: options.gaps ?? [] }),
    },
    drawer: {
      findMany: async () =>
        Object.entries(options.drawerBalances ?? {}).map(([currencyCode, balance]) => ({
          ownerKey: 'teller:ahmad',
          currencyCode,
          kind: 'CASH',
          balance,
        })),
    },
  } as never;
}

const line = (patch: Partial<Line>): Line => ({
  currencyCode: 'ILS',
  kind: 'CASH',
  nature: 'COUNTED',
  amount: 1_000n * UNIT,
  countedAmount: null,
  ...patch,
});

const teller = { id: 'ahmad', permissions: ['treasury.handover.receive'] };
const manager = { id: 'boss', permissions: ['treasury.handover.manage'] };

describe('a count record', () => {
  it('reads the books from the drawer while the handover waits', async () => {
    const db = fakeDb({
      status: 'PENDING',
      lines: [line({})],
      drawerBalances: { ILS: 1_050n * UNIT },
    });

    const record = await countRecord('h1', manager, db);
    const [ils] = record.lines;

    assert.equal(ils?.expected, 1_050n * UNIT);
    assert.equal(ils?.declared, 1_000n * UNIT);
    assert.equal(ils?.difference, null, 'nothing is a difference until it is counted');
  });

  it('rebuilds the books after the close: counted plus the gap it booked', async () => {
    const db = fakeDb({
      status: 'CONFIRMED',
      lines: [line({ countedAmount: 1_000n * UNIT })],
      gaps: [{ currencyCode: 'ILS', amount: 50n * UNIT }],
    });

    const [ils] = (await countRecord('h1', manager, db)).lines;

    assert.equal(ils?.expected, 1_050n * UNIT);
    assert.equal(ils?.counted, 1_000n * UNIT);
    assert.equal(ils?.difference, 50n * UNIT, 'a shortage of fifty');
  });

  it('reads a clean count as clean', async () => {
    const db = fakeDb({
      status: 'CONFIRMED',
      lines: [line({ countedAmount: 1_000n * UNIT })],
      gaps: [],
    });
    const [ils] = (await countRecord('h1', manager, db)).lines;
    assert.equal(ils?.difference, 0n);
  });

  it('is for the teller it is about', async () => {
    const db = fakeDb({ status: 'PENDING', lines: [line({})] });
    await assert.doesNotReject(() => countRecord('h1', teller, db));
  });

  it('is not for another teller', async () => {
    const db = fakeDb({ status: 'PENDING', lines: [line({})] });
    await assert.rejects(
      () => countRecord('h1', { id: 'sami', permissions: ['treasury.handover.receive'] }, db),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
  });
});
