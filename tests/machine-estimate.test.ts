import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convert, invertRate, parseMoney } from '../src/core/money/money.ts';
import { estimate, rateFor } from '../src/app/(app)/counter/machine/estimate.ts';

const m = (value: string) => parseMoney(value).toString();

const rates = [
  { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: m('3.60'), sellRate: m('3.70'), effectiveFrom: '2026-11-19T08:00:00Z' },
  // An older row for the same pair is not the one read.
  { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: m('3.10'), sellRate: m('3.20'), effectiveFrom: '2026-11-18T08:00:00Z' },
  { baseCode: 'USD', quoteCode: 'ILS', channel: 'BROKER', buyRate: m('3.62'), sellRate: m('3.68'), effectiveFrom: '2026-11-19T08:00:00Z' },
  // Published the wrong way round: never read.
  { baseCode: 'ILS', quoteCode: 'JOD', channel: 'CASH', buyRate: m('5'), sellRate: m('5'), effectiveFrom: '2026-11-19T08:00:00Z' },
];

const base = { rates, fromDecimals: 2, toDecimals: 2, through: 'CASH' as const };

describe('the machine’s price worked out on the screen', () => {
  it('buys at the board’s buying price, on each channel', () => {
    const priced = estimate({ ...base, from: 'USD', to: 'ILS', side: 'pay', amount: '100' });
    assert.equal(priced?.cash?.toAmount, m('360'));
    assert.equal(priced?.broker?.toAmount, m('362'));
  });

  it('sells at the selling price turned round, rounded as the server rounds', () => {
    const priced = estimate({ ...base, from: 'ILS', to: 'USD', side: 'pay', amount: '370' });
    const expected = convert(parseMoney('370'), invertRate(parseMoney('3.70')), 2);
    assert.equal(priced?.cash?.toAmount, expected.toString());
    assert.equal(priced?.cash?.rate, invertRate(parseMoney('3.70')).toString());
  });

  it('sizes a figure to take away against the chosen channel, then prices both', () => {
    const priced = estimate({ ...base, from: 'USD', to: 'ILS', side: 'receive', amount: '720' });
    assert.equal(priced?.cash?.fromAmount, m('200'));
    assert.equal(priced?.cash?.toAmount, m('720'));
    assert.equal(priced?.broker?.fromAmount, m('200'));
  });

  it('gives nothing to show when no price is published or nothing is typed', () => {
    assert.equal(rateFor(rates, 'ILS', 'JOD', 'CASH'), null);
    assert.equal(estimate({ ...base, from: 'JOD', to: 'ILS', side: 'pay', amount: '10' }), null);
    assert.equal(estimate({ ...base, from: 'USD', to: 'ILS', side: 'pay', amount: '' }), null);
    assert.equal(estimate({ ...base, from: 'USD', to: 'ILS', side: 'pay', amount: '0' }), null);
  });
});
