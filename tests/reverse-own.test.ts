// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { reverse } from '../src/modules/exchange/transaction.service.ts';

/**
 * A teller deleting his own exchange.
 *
 * He may undo a wrong entry he made himself, from the machine — and nothing
 * wider: not another teller's work, not a USDT or remittance deal, not one
 * whose transfer has already left the bank. Each of those stays the manager's.
 */

const teller = {
  id: 'ahmad',
  name: 'Ahmad',
  branchId: 'main',
  permissions: ['exchange.transaction.view', 'exchange.transaction.reverseOwn'],
};

const original = {
  id: 't1',
  reference: 'TXN-1',
  type: 'EXCHANGE',
  status: 'POSTED',
  branchId: 'main',
  createdById: 'ahmad',
  businessDayId: 'd-today',
  transferConfirmedAt: null as Date | null,
  reversalOfId: null,
};

function fakeDb(row: typeof original) {
  return {
    transaction: { findUnique: async () => row, findFirst: async () => null },
  } as never;
}

const refused = async (row: typeof original, actor = teller) => {
  await assert.rejects(
    () => reverse(row.id, 'إدخال خاطئ', actor, fakeDb(row)),
    (error: { code?: string }) => error.code === 'FORBIDDEN',
  );
};

describe('a teller deleting his own exchange', () => {
  it('is refused without the permission', async () => {
    await refused(original, { ...teller, permissions: ['exchange.transaction.view'] });
  });

  it('is refused for another teller’s exchange', async () => {
    await refused({ ...original, createdById: 'sami' });
  });

  it('is refused for a USDT deal', async () => {
    await refused({ ...original, type: 'USDT_RECEIVE' });
  });

  it('is refused once its transfer has been sent', async () => {
    await assert.rejects(
      () =>
        reverse(
          original.id,
          'إدخال خاطئ',
          teller,
          fakeDb({ ...original, transferConfirmedAt: new Date() }),
        ),
      (error: { messageKey?: string }) => error.messageKey === 'errors.ownReverseSent',
    );
  });
});
