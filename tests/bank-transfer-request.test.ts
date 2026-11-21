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

  it('never takes a wallet or a bank the counter does not list for the name', () => {
    // As it came in the group: the wallet above the name.
    const read = readTransferRequest('0597198493\n\nمحفظة\n\nهديل الاستاذ\n\n350  شيكل', CHANNELS);
    assert.equal(read?.channel, 'محفظة');
    assert.equal(read?.name, 'هديل الاستاذ');
    assert.equal(read?.amount, 350n * UNIT);
    assert.equal(readTransferRequest('0597000000\nبنك الاردن\nسامر\n100', CHANNELS)?.name, 'سامر');
  });

  it('reads a transfer written out of order, with dots and an order word among its lines', () => {
    // As it came in the group.
    const read = readTransferRequest('.0599946133.\nاياد زويد العطار\nبنك\nارسال\n600 دولار\n.', CHANNELS);
    assert.equal(read?.account, '0599946133');
    assert.equal(read?.name, 'اياد زويد العطار');
    assert.equal(read?.channel, 'بنك');
    assert.equal(read?.amount, 600n * UNIT);
    assert.equal(read?.currency, 'USD');
    // The order word is never the name, wherever it stands.
    assert.equal(readTransferRequest('0599946133\nارسال\nاياد العطار\n600', CHANNELS)?.name, 'اياد العطار');
  });

  it('knows a listed bank spelt the short way', () => {
    const read = readTransferRequest('0599732007\n\nجوال بي\n\n200 شيكل\n\nاحمد ابو جراد', CHANNELS);
    assert.equal(read?.channel, 'جوال باي');
    assert.equal(read?.name, 'احمد ابو جراد');
  });
});
