// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moveRefusal } from '../src/modules/exchange/transaction.service.ts';

/**
 * Handing a deal to the teller it belonged to. Pinned: what may not be moved,
 * and above all a transfer already sent, which undoing would record as still
 * owed.
 */

const deal = (over = {}) => ({
  type: 'EXCHANGE',
  status: 'POSTED',
  reversalOfId: null,
  transferConfirmedAt: null,
  createdById: 'admin',
  businessDayId: 'today',
  ...over,
});

describe('moving a deal to a teller', () => {
  it('allows a standing machine deal from the open day', () => {
    assert.equal(moveRefusal(deal(), 'teller', 'today'), null);
    assert.equal(moveRefusal(deal({ status: 'PENDING_TRANSFER' }), 'teller', 'today'), null);
    assert.equal(moveRefusal(deal({ type: 'WALLET_CASHOUT' }), 'teller', 'today'), null);
  });

  it('refuses a transfer that has already been sent', () => {
    const sent = deal({ status: 'PENDING_TRANSFER', transferConfirmedAt: new Date() });
    assert.equal(moveRefusal(sent, 'teller', 'today'), 'errors.ownReverseSent');
  });

  it('refuses anything the machine did not record', () => {
    assert.equal(
      moveRefusal(deal({ type: 'USDT_RECEIVE' }), 'teller', 'today'),
      'errors.moveNotMachineDeal',
    );
  });

  it('refuses a deal already deleted, and a reversal itself', () => {
    assert.equal(moveRefusal(deal({ status: 'REVERSED' }), 'teller', 'today'), 'errors.notPosted');
    assert.equal(
      moveRefusal(deal({ reversalOfId: 'x' }), 'teller', 'today'),
      'errors.cannotReverseReversal',
    );
  });

  it('refuses the teller who already has it', () => {
    assert.equal(moveRefusal(deal(), 'admin', 'today'), 'errors.moveSameTeller');
  });

  it('refuses a deal from an earlier day, which would land in today', () => {
    assert.equal(
      moveRefusal(deal({ businessDayId: 'yesterday' }), 'teller', 'today'),
      'errors.moveOldDay',
    );
  });
});
