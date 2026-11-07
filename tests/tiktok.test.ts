import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeWithdrawal,
  composeWithdrawalDeleted,
  composeWithdrawalName,
  composeWithdrawalNameDeleted,
  rateText,
  tiktokPayout,
  tiktokTotals,
} from '../src/modules/tiktok/tiktok-message.ts';
import { copyGroupFor, groupFor, groupPlan } from '../src/modules/whatsapp/group-routes.ts';

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

  it('adds up a day from those that stand, each currency apart', () => {
    const row = (amount: bigint, currency: string, payoutAmount: bigint, deleted = false) => ({
      amount,
      currency,
      payoutAmount,
      deleted,
    });
    assert.deepEqual(
      tiktokTotals([
        row(100n * UNIT, 'USDT', 255n * UNIT),
        row(50n * UNIT, 'USDT', 128n * UNIT),
        row(10n * UNIT, 'USD', 0n),
        row(900n * UNIT, 'USDT', 2295n * UNIT, true),
      ]),
      {
        withdrawn: [
          { currency: 'USDT', amount: 150n * UNIT },
          { currency: 'USD', amount: 10n * UNIT },
        ],
        paid: 383n * UNIT,
        count: 3,
      },
    );
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

  it('gives the second group the name alone, and its deletion the name alone', () => {
    assert.equal(composeWithdrawalName(withdrawal), 'ليندا الفقعاوي');
    assert.equal(composeWithdrawalNameDeleted(withdrawal), '🔴 *سحب ملغى*\n\nليندا الفقعاوي');
  });

  it('sends the photo and name only where a group is chosen for it, and not twice', () => {
    const full = { TIKTOK: { id: 'tt@g.us', name: 'تيكتوك' } };
    assert.equal(copyGroupFor('TIKTOK_WITHDRAWAL', full, 'main@g.us'), '', 'none by itself');
    const named = { ...full, TIKTOK_NAME: { id: 'names@g.us', name: 'الأسماء' } };
    assert.equal(copyGroupFor('TIKTOK_WITHDRAWAL', named, 'main@g.us'), 'names@g.us');
    assert.equal(groupFor('TIKTOK_WITHDRAWAL', named, 'main@g.us'), 'tt@g.us');
    const same = { ...full, TIKTOK_NAME: { id: 'tt@g.us', name: 'تيكتوك' } };
    assert.equal(copyGroupFor('TIKTOK_WITHDRAWAL', same, 'main@g.us'), '');
    assert.ok(
      groupPlan(named, 'main@g.us').some(
        ({ id, hears }) => id === 'names@g.us' && hears.includes('صورة تيكتوك والاسم'),
      ),
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
