// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeDeletion, titleOf, type AnnouncedDeal } from '../src/modules/whatsapp/announce.ts';

/**
 * What the WhatsApp group reads when a deal is deleted. Pinned: buying and
 * selling said plainly, with the reason and who deleted it. The deal itself
 * is written by the share message, pinned in its own tests.
 */

const UNIT = 100_000_000n;

const deal = (over: Partial<AnnouncedDeal> = {}): AnnouncedDeal => ({
  reference: 'TXN-20261029-00001',
  type: 'EXCHANGE',
  status: 'POSTED',
  fromCurrency: 'USD',
  fromAmount: 100n * UNIT,
  toCurrency: 'ILS',
  toAmount: 365n * UNIT,
  payoutBankAmount: 0n,
  payoutBankChannel: null,
  payoutAccount: null,
  intakeBrokerAmount: 0n,
  intakeBankChannel: null,
  counterpartyName: null,
  counterpartyPhone: null,
  notes: null,
  createdAt: new Date('2026-10-29T10:05:00Z'),
  customer: null,
  createdBy: { fullNameAr: 'أحمد' },
  ...over,
});

describe('the WhatsApp announcement', () => {
  it('says buying and selling from the office’s side', () => {
    assert.equal(titleOf(deal()), 'شراء USD');
    assert.equal(titleOf(deal({ fromCurrency: 'ILS', toCurrency: 'USD' })), 'بيع USD');
    assert.equal(titleOf(deal({ type: 'USDT_SALE' })), 'بيع USDT');
  });

  it('announces a deletion with its reason', () => {
    const text = composeDeletion(deal(), 'سامي', 'خطأ في المبلغ');
    assert.match(text, /حذف عملية — شراء USD/);
    assert.match(text, /السبب: خطأ في المبلغ/);
    assert.match(text, /حذفها: سامي/);
  });
});
