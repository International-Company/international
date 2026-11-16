import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  balancesFor,
  categoryOf,
  isReceivedRemittance,
  isSentRemittance,
} from '../src/modules/exchange/transaction-types.ts';
import { copyGroupFor, groupFor } from '../src/modules/whatsapp/group-routes.ts';

describe('a PayPal remittance', () => {
  it('moves the PayPal balance where a remittance moves the correspondent’s', () => {
    assert.deepEqual(balancesFor('PAYPAL_OUT'), { intake: null, payout: 'PAYPAL' });
    assert.deepEqual(balancesFor('PAYPAL_IN'), { intake: 'PAYPAL', payout: null });
    assert.deepEqual(balancesFor('REMITTANCE_OUT'), { intake: null, payout: 'CORRESPONDENT' });
  });

  it('is a remittance sent or received everywhere one is', () => {
    assert.equal(isSentRemittance('PAYPAL_OUT'), true);
    assert.equal(isReceivedRemittance('PAYPAL_IN'), true);
    assert.equal(isSentRemittance('PAYPAL_IN'), false);
    assert.equal(categoryOf('PAYPAL_OUT'), 'REMITTANCE');
  });

  it('goes to its own group, else to the remittances’, else to the main one', () => {
    const own = { PAYPAL: { id: 'pp@g.us', name: 'باي بال' } };
    const remit = { REMITTANCE: { id: 'rem@g.us', name: 'الحوالات' } };
    assert.equal(groupFor('PAYPAL_OUT', own, 'main@g.us'), 'pp@g.us');
    assert.equal(groupFor('PAYPAL_IN', remit, 'main@g.us'), 'rem@g.us');
    assert.equal(groupFor('PAYPAL_IN', {}, 'main@g.us'), 'main@g.us');
  });

  it('copies as a remittance does: the number and sum sent, a transfer paid out', () => {
    const routes = {
      REMITTANCE_COPY: { id: 'copy@g.us', name: 'الأرقام' },
      BANK_COPY: { id: 'bank@g.us', name: 'البنك' },
    };
    assert.equal(copyGroupFor('PAYPAL_OUT', routes, 'main@g.us'), 'copy@g.us');
    assert.equal(copyGroupFor('PAYPAL_IN', routes, 'main@g.us'), 'bank@g.us');
  });
});
