import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { feeOn, priceRemittance, validFee } from '../src/modules/exchange/remittance-pricing.ts';
import { MAX_PROOF_BYTES, readProofImage } from '../src/modules/exchange/proof-image.ts';

/**
 * A destination's price list, and a photo of what the customer paid. Pinned: what
 * a sum comes to, each fee flat or a percentage, and that only a real picture of
 * a reasonable size is ever kept.
 */

const UNIT = 100_000_000n;
const flat = (value: number) => ({ kind: 'FLAT' as const, value: BigInt(value) * UNIT });
const percent = (value: number) => ({
  kind: 'PERCENT' as const,
  value: BigInt(Math.round(value * 100)) * (UNIT / 100n),
});

describe('pricing a remittance', () => {
  it('adds both flat fees to the sum', () => {
    assert.deepEqual(priceRemittance(1000n * UNIT, { charge: flat(20), cost: flat(10) }, 2), {
      collected: 1020n * UNIT,
      cost: 1010n * UNIT,
      margin: 10n * UNIT,
    });
  });

  it('takes a percentage of the sum, either way', () => {
    assert.deepEqual(priceRemittance(1000n * UNIT, { charge: percent(2), cost: percent(1.5) }, 2), {
      collected: 1020n * UNIT,
      cost: 1015n * UNIT,
      margin: 5n * UNIT,
    });
    assert.deepEqual(priceRemittance(1000n * UNIT, { charge: percent(2), cost: flat(10) }, 2), {
      collected: 1020n * UNIT,
      cost: 1010n * UNIT,
      margin: 10n * UNIT,
    });
  });

  it('rounds a percentage to what the currency can express', () => {
    // 1.5% of 333.33 is 4.99995.
    assert.equal(feeOn(33_333_000_000n, percent(1.5), 2), 500_000_000n);
  });

  it('shows a loss when the correspondent charges more', () => {
    assert.equal(
      priceRemittance(100n * UNIT, { charge: flat(5), cost: flat(8) }, 2).margin,
      -3n * UNIT,
    );
  });

  it('refuses a fee that cannot be', () => {
    assert.equal(validFee(flat(0)), true);
    assert.equal(validFee(flat(5000)), true);
    assert.equal(validFee(percent(99.5)), true);
    assert.equal(validFee(percent(100)), false);
    assert.equal(validFee({ kind: 'FLAT', value: -1n }), false);
  });
});

describe('a photo of what the customer paid', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

  it('accepts a JPEG and a PNG, by their bytes', () => {
    const read = readProofImage(jpeg.toString('base64'));
    assert.ok(typeof read !== 'string');
    assert.equal(read.mimeType, 'image/jpeg');
    assert.deepEqual(read.bytes, jpeg);
    const other = readProofImage(png.toString('base64'));
    assert.ok(typeof other !== 'string');
    assert.equal(other.mimeType, 'image/png');
  });

  it('accepts one sent with its data: prefix', () => {
    assert.ok(
      typeof readProofImage(`data:image/jpeg;base64,${jpeg.toString('base64')}`) !== 'string',
    );
  });

  it('refuses anything that is not a picture, whatever it claims to be', () => {
    const html = Buffer.from('<script>alert(1)</script>').toString('base64');
    assert.equal(readProofImage(html), 'errors.proofImageInvalid');
    assert.equal(readProofImage(`data:image/jpeg;base64,${html}`), 'errors.proofImageInvalid');
    assert.equal(readProofImage('not base64 at all!!'), 'errors.proofImageInvalid');
    assert.equal(readProofImage(''), 'errors.proofImageInvalid');
  });

  it('refuses one too large to keep', () => {
    const big = Buffer.concat([jpeg, Buffer.alloc(MAX_PROOF_BYTES)]);
    assert.equal(readProofImage(big.toString('base64')), 'errors.proofImageTooLarge');
  });
});
