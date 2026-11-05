import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeWithdrawal,
  composeWithdrawalDeleted,
} from '../src/modules/tiktok/tiktok-message.ts';
import { groupFor, groupPlan } from '../src/modules/whatsapp/group-routes.ts';

const UNIT = 100_000_000n;
const withdrawal = {
  amount: 250n * UNIT,
  currency: 'USD',
  beneficiaryName: '  أحمد علي  ',
  channel: 'بنك فلسطين',
  teller: 'سامي',
};

describe('a TikTok withdrawal in the group', () => {
  it('says who it is for, how it is sent, the amount and who wrote it', () => {
    assert.equal(
      composeWithdrawal(withdrawal),
      '*سحب تيكتوك*\n\nالمستفيد: أحمد علي\nطريقة التحويل: بنك فلسطين\nالمبلغ: *250 دولار*\nالتلر: سامي',
    );
  });

  it('leaves the method out of a record from before it was asked for', () => {
    assert.doesNotMatch(composeWithdrawal({ ...withdrawal, channel: '' }), /طريقة التحويل/);
  });

  it('goes without a teller when none can be named', () => {
    assert.doesNotMatch(composeWithdrawal({ ...withdrawal, teller: null }), /التلر/);
  });

  it('says what was deleted, and by whom', () => {
    const text = composeWithdrawalDeleted(withdrawal, 'المدير');
    assert.match(text, /حذف سحب تيكتوك/);
    assert.match(text, /أحمد علي/);
    assert.match(text, /كان: 250 دولار/);
    assert.match(text, /حذفها: المدير/);
  });

  it('reaches its own group, or the main one until it has one', () => {
    const routes = { TIKTOK: { id: 'tt@g.us', name: 'تيكتوك' } };
    assert.equal(groupFor('TIKTOK_WITHDRAWAL', routes, 'main@g.us'), 'tt@g.us');
    assert.equal(groupFor('TIKTOK_WITHDRAWAL', {}, 'main@g.us'), 'main@g.us');
    assert.ok(groupPlan(routes, 'main@g.us').some(({ id, hears }) => id === 'tt@g.us' && hears.includes('تيكتوك')));
  });
});
