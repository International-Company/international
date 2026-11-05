import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeWithdrawal,
  composeWithdrawalDeleted,
  rateText,
  tiktokPayout,
} from '../src/modules/tiktok/tiktok-message.ts';
import { groupFor, groupPlan } from '../src/modules/whatsapp/group-routes.ts';

const UNIT = 100_000_000n;
const cents = (value: number) => (BigInt(Math.round(value * 100)) * UNIT) / 100n;
const withdrawal = {
  amount: cents(77.68),
  currency: 'USD',
  account: '0592117818',
  channel: 'جوال باي',
  beneficiaryName: '  ليندا الفقعاوي  ',
  payoutAmount: 198n * UNIT,
};

describe('a TikTok withdrawal', () => {
  it('turns dollars into whole shekels at its price, as the office rounds', () => {
    assert.equal(tiktokPayout(cents(77.68), cents(2.55)), 198n * UNIT);
    // 915.6 is 916; 915.5 is 915.
    assert.equal(tiktokPayout(cents(915.6), UNIT), 916n * UNIT);
    assert.equal(tiktokPayout(cents(915.5), UNIT), 915n * UNIT);
  });

  it('shows a price as it is typed', () => {
    assert.equal(rateText(cents(2.55)), '2.55');
    assert.equal(rateText(3n * UNIT), '3');
    assert.equal(rateText(10n * UNIT), '10');
    assert.equal(rateText((25_505n * UNIT) / 10_000n), '2.5505');
  });

  it('goes to the group a line each, as the office writes it', () => {
    assert.equal(
      composeWithdrawal(withdrawal),
      '0592117818\n\nجوال باي\n\nليندا الفقعاوي\n\n198 ش',
    );
  });

  it('says what was deleted, and by whom', () => {
    const text = composeWithdrawalDeleted(withdrawal, 'المدير');
    assert.match(text, /حذف سحب تيكتوك/);
    assert.match(text, /0592117818/);
    assert.match(text, /ليندا الفقعاوي/);
    assert.match(text, /198 ش/);
    assert.match(text, /حذفها: المدير/);
  });

  it('names a record from before the shekels by its dollars', () => {
    const text = composeWithdrawalDeleted(
      { ...withdrawal, account: '', channel: '', payoutAmount: 0n },
      null,
    );
    assert.match(text, /77\.68 دولار/);
    assert.doesNotMatch(text, / ش$/);
  });

  it('reaches its own group, or the main one until it has one', () => {
    const routes = { TIKTOK: { id: 'tt@g.us', name: 'تيكتوك' } };
    assert.equal(groupFor('TIKTOK_WITHDRAWAL', routes, 'main@g.us'), 'tt@g.us');
    assert.equal(groupFor('TIKTOK_WITHDRAWAL', {}, 'main@g.us'), 'main@g.us');
    assert.ok(
      groupPlan(routes, 'main@g.us').some(
        ({ id, hears }) => id === 'tt@g.us' && hears.includes('تيكتوك'),
      ),
    );
  });
});
