// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeDeal,
  composeDeletion,
  priceOf,
  titleOf,
  type AnnouncedDeal,
} from '../src/modules/whatsapp/announce.ts';

/**
 * What the WhatsApp group reads for each deal. Pinned: buying and selling
 * said plainly, the price per unit of what was traded, the transfer spelled
 * out when there is one, and nothing printed for a field the deal lacks.
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

  it('prices per unit of what was traded', () => {
    assert.equal(priceOf(deal()), '3.65');
    // A USDT sale: 365 shekels for 100 coins.
    assert.equal(
      priceOf(
        deal({ fromCurrency: 'ILS', fromAmount: 365n * UNIT, toCurrency: 'USDT', toAmount: 100n * UNIT }),
      ),
      '3.65',
    );
  });

  it('writes the deal, the transfer and the teller, and skips what is missing', () => {
    const text = composeDeal(
      deal({
        counterpartyName: 'محمد',
        payoutBankAmount: 365n * UNIT,
        payoutBankChannel: 'بنك فلسطين',
        payoutAccount: '0599000000',
        status: 'PENDING_TRANSFER',
      }),
    );
    assert.match(text, /شراء USD/);
    assert.match(text, /العميل: محمد/);
    assert.match(text, /دفع العميل: 100 USD/);
    assert.match(text, /استلم العميل: 365 ILS/);
    assert.match(text, /يُحوَّل له: 365 ILS — بنك فلسطين — 0599000000/);
    assert.match(text, /بانتظار التحويل/);
    assert.match(text, /التلر: أحمد · 12:05/);
    assert.doesNotMatch(text, /الهاتف/);
    assert.doesNotMatch(text, /ملاحظة/);
  });

  it('announces a deletion with its reason', () => {
    const text = composeDeletion(deal(), 'سامي', 'خطأ في المبلغ');
    assert.match(text, /حذف عملية — شراء USD/);
    assert.match(text, /السبب: خطأ في المبلغ/);
    assert.match(text, /حذفها: سامي/);
  });
});
