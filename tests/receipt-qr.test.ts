import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeQr } from '../src/core/qr/encoder.ts';
import { RECEIPT_QR_MAX_BYTES, receiptQrText } from '../src/modules/exchange/receipt-qr.ts';

/**
 * What a receipt's QR says. Pinned: the deal in plain text, no address of any
 * kind, and always small enough to encode — a QR that throws would stop the
 * receipt printing at all.
 */

const UNIT = 100_000_000n;

const receipt = (over = {}) => ({
  company: 'انترنشونال',
  number: 'TXN-20261104-00004',
  when: '04 نوفمبر 2026، 09:55',
  paid: { amount: 900n * UNIT, currency: 'USD' },
  received: { amount: 3273n * UNIT, currency: 'ILS' },
  ...over,
});

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('the text in a receipt’s QR', () => {
  it('says the deal, line by line', () => {
    assert.deepEqual(receiptQrText(receipt()).split('\n'), [
      'انترنشونال',
      'إيصال: TXN-20261104-00004',
      '04 نوفمبر 2026، 09:55',
      'دفع: 900.00 USD',
      'استلم: 3273.00 ILS',
    ]);
  });

  it('carries no address', () => {
    assert.doesNotMatch(receiptQrText(receipt()), /https?:|www\.|railway|\/verify/i);
  });

  it('keeps the office’s full name', () => {
    const company = 'شركة انترنشونال للخدمات المالية والمجوهرات';
    assert.match(receiptQrText(receipt({ company })), new RegExp(`^${company}\n`));
  });

  it('leaves out a company name too long to fit, never the deal', () => {
    const text = receiptQrText(receipt({ company: 'شركة '.repeat(40) }));
    assert.doesNotMatch(text, /شركة/);
    assert.match(text, /TXN-20261104-00004/);
    assert.ok(bytes(text) <= RECEIPT_QR_MAX_BYTES);
  });

  it('always encodes, at the largest deal the books can hold', () => {
    const largest = { amount: 90_000_000_000n * UNIT, currency: 'USDT' };
    const text = receiptQrText(
      receipt({
        company: 'ش'.repeat(200),
        number: 'TXN-20261104-99999',
        paid: largest,
        received: largest,
      }),
    );
    assert.ok(encodeQr(text, { level: 'M' }).size > 0);
    // And at the very edge of what the company's name is allowed to take.
    const edge = 'x'.repeat(RECEIPT_QR_MAX_BYTES);
    assert.ok(encodeQr(edge, { level: 'M' }).size > 0);
  });
});
