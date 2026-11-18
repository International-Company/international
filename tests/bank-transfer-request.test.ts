import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readTransferRequest } from '../src/modules/bank/transfer-request.ts';

const CHANNELS = ['بال باي', 'جوال باي', 'بنك فلسطين', 'بنك القدس', 'بنك الاسلامي الفلسطيني'];
const UNIT = 100_000_000n;

describe('a transfer request, read off a group message', () => {
  it('reads the office’s own four lines', () => {
    assert.deepEqual(readTransferRequest('0592117818\n\nليندا\n\nبال باي\n\n500 ش', CHANNELS), {
      account: '0592117818',
      name: 'ليندا',
      channel: 'بال باي',
      amount: 500n * UNIT,
      currency: 'ILS',
    });
  });

  it('reads them in another order, with Arabic digits, commas and a unit', () => {
    const read = readTransferRequest('بنك فلسطين\nمحمد أحمد\n١٬٢٠٠ شيكل\n٠٥٩٩١١١٢٢٢', CHANNELS);
    assert.equal(read?.account, '0599111222');
    assert.equal(read?.channel, 'بنك فلسطين');
    assert.equal(read?.name, 'محمد أحمد');
    assert.equal(read?.amount, 1200n * UNIT);
  });

  it('knows dollars, and a sum written alone', () => {
    assert.equal(readTransferRequest('0597000000\nفادي\nجوال باي\n$300', CHANNELS)?.currency, 'USD');
    const plain = readTransferRequest('0597000000\nفادي\n250', CHANNELS);
    assert.equal(plain?.amount, 250n * UNIT);
    assert.equal(plain?.channel, null);
  });

  it('matches a bank written a little differently', () => {
    assert.equal(
      readTransferRequest('123456789\nسامي\nالبنك الإسلامي الفلسطيني\n100', CHANNELS)?.channel,
      'بنك الاسلامي الفلسطيني',
    );
    assert.equal(readTransferRequest('123456789\nسامي\nبنك الإسلامي الفلسطيني\n100', CHANNELS)?.channel, 'بنك الاسلامي الفلسطيني');
  });

  it('takes nothing that is not a transfer', () => {
    assert.equal(readTransferRequest('تم التحويل ✅', CHANNELS), null);
    assert.equal(readTransferRequest('كم سعر الدولار اليوم؟', CHANNELS), null);
    assert.equal(readTransferRequest('0599111222', CHANNELS), null);
    assert.equal(readTransferRequest('0599111222\n500', CHANNELS), null);
  });
});
