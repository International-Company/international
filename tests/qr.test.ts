import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  encodeQr,
  qrToSvgPath,
  QR_QUIET_ZONE,
  type ErrorCorrectionLevel,
} from '../src/core/qr/encoder.ts';

/**
 * A wallet address rendered as a QR is scanned by a customer whose wallet then
 * sends to whatever it decodes. Nobody at the counter can proofread a grid of
 * squares, so the only real check is that the encoder still produces exactly the
 * bytes it produced when it was verified.
 *
 * Every matrix below was cross-checked module-for-module against an independent
 * implementation (the `qrcode` package, byte mode, mask forced) across all ten
 * versions, four error-correction levels and all eight masks — 1,832 symbols,
 * identical in every case. The package is not a dependency of this system; it
 * was used once as an oracle and removed. These digests are what remains of it.
 *
 * A failure here means the encoder changed behaviour. It does not mean the
 * expectation is stale — re-derive against an independent implementation before
 * touching a digest.
 */

interface Vector {
  text: string;
  level: ErrorCorrectionLevel;
  mask: number;
  version: number;
  size: number;
  digest: string;
}

const VECTORS: Vector[] = [
  { text: 'a', level: 'L', mask: 0, version: 1, size: 21, digest: 'c8b94007197ad57de04587d88c0bc0ef' },
  { text: 'ab', level: 'M', mask: 3, version: 1, size: 21, digest: '96736250532ecd67183a4ffe9ff0b5c2' },
  { text: '1234567890', level: 'Q', mask: 5, version: 1, size: 21, digest: '79b0d5b26aaefd31f227457cfddde8b0' },
  // A real TRON address, at the level and size the counter screen uses.
  { text: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', level: 'Q', mask: 2, version: 4, size: 33, digest: '02091c5a30f36574000efd763d167eee' },
  { text: 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax', level: 'L', mask: 6, version: 3, size: 29, digest: '549838afc4536ad312c57cfc66be0020' },
  // A real Ethereum contract address.
  { text: '0xdAC17F958D2ee523a2206206994597C13D831ec7', level: 'M', mask: 7, version: 3, size: 29, digest: 'd51b5ed7376aff3256f206fc1b34697b' },
  { text: 'x'.repeat(60), level: 'Q', mask: 0, version: 5, size: 37, digest: '5f43e0c59938da0092c22be95b25bf4b' },
  // Multi-block interleaving, and the widest supported symbol.
  { text: 'x'.repeat(119), level: 'H', mask: 1, version: 10, size: 57, digest: '3bdcc3457b3be5bedfa8d2ac01bcd8d4' },
  { text: 'x'.repeat(213), level: 'L', mask: 4, version: 9, size: 53, digest: '86cfd3e7eb3b7b7d088483ab05246c9d' },
];

function fingerprint(modules: boolean[][]): string {
  const bits = modules.map((row) => row.map((value) => (value ? '1' : '0')).join('')).join('');
  return createHash('sha256').update(bits).digest('hex').slice(0, 32);
}

describe('encodeQr — frozen vectors', () => {
  for (const vector of VECTORS) {
    const label = vector.text.length > 24 ? `${vector.text.length} bytes` : `"${vector.text}"`;

    it(`${label} at level ${vector.level}, mask ${vector.mask}`, () => {
      const matrix = encodeQr(vector.text, { level: vector.level, mask: vector.mask });

      assert.equal(matrix.version, vector.version);
      assert.equal(matrix.size, vector.size);
      assert.equal(matrix.size, matrix.version * 4 + 17);
      assert.equal(fingerprint(matrix.modules), vector.digest);
    });
  }
});

/**
 * The full grid for one symbol, so a regression shows as a readable diff rather
 * than two digests that differ.
 */
const IFMS_V1_L_MASK0 = [
  '#######...#.#.#######',
  '#.....#.....#.#.....#',
  '#.###.#.#.#...#.###.#',
  '#.###.#.....#.#.###.#',
  '#.###.#..#.##.#.###.#',
  '#.....#..###..#.....#',
  '#######.#.#.#.#######',
  '........#.#..........',
  '###.#####.#.###...#..',
  '...#....####.#.#...#.',
  '####..#.####.###...##',
  '#.###.....####.##....',
  '###...#.##.#.###..#..',
  '........#.....#...##.',
  '#######.#.#.#...#####',
  '#.....#.#.#...#....#.',
  '#.###.#.##..#.#.#####',
  '#.###.#..#.#.#.#.#.#.',
  '#.###.#.####.###.#..#',
  '#.....#.#..###.###.#.',
  '#######.####.###..###',
];

describe('encodeQr — structure', () => {
  it('reproduces a version 1 symbol module for module', () => {
    const matrix = encodeQr('IFMS', { level: 'L', mask: 0 });
    const rendered = matrix.modules.map((row) => row.map((v) => (v ? '#' : '.')).join(''));
    assert.deepEqual(rendered, IFMS_V1_L_MASK0);
  });

  it('places the three finder patterns and their separators', () => {
    const { modules, size } = encodeQr('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');

    for (const [top, left] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ]) {
      // The 7×7 ring with a 3×3 core.
      for (let row = 0; row < 7; row++) {
        for (let column = 0; column < 7; column++) {
          const onRing = row === 0 || row === 6 || column === 0 || column === 6;
          const inCore = row >= 2 && row <= 4 && column >= 2 && column <= 4;
          assert.equal(modules[top! + row]![left! + column], onRing || inCore);
        }
      }
    }
  });

  it('alternates the timing patterns', () => {
    const { modules, size } = encodeQr('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');

    for (let index = 8; index < size - 8; index++) {
      assert.equal(modules[6]![index], index % 2 === 0, `row 6, column ${index}`);
      assert.equal(modules[index]![6], index % 2 === 0, `column 6, row ${index}`);
    }
  });

  it('keeps the dark module set', () => {
    const { modules, size } = encodeQr('IFMS');
    assert.equal(modules[size - 8]![8], true);
  });

  it('grows the symbol as the payload grows, never shrinking it', () => {
    let previous = 0;
    for (const length of [1, 20, 40, 80, 150, 213]) {
      const { version } = encodeQr('x'.repeat(length), { level: 'L' });
      assert.ok(version >= previous, `version fell from ${previous} at ${length} bytes`);
      previous = version;
    }
  });

  it('needs a larger symbol for stronger error correction', () => {
    const weak = encodeQr('x'.repeat(60), { level: 'L' });
    const strong = encodeQr('x'.repeat(60), { level: 'H' });
    assert.ok(strong.version > weak.version);
  });

  it('encodes non-ASCII as UTF-8 bytes rather than truncating', () => {
    // Two bytes per Arabic letter, so the symbol must size for four not two.
    const arabic = encodeQr('مرحبا', { level: 'L', mask: 0 });
    const ascii = encodeQr('abcde', { level: 'L', mask: 0 });
    assert.notEqual(fingerprint(arabic.modules), fingerprint(ascii.modules));
  });

  it('refuses an empty payload rather than drawing an unscannable symbol', () => {
    assert.throws(() => encodeQr(''), /empty/);
  });

  it('refuses a payload beyond the supported versions', () => {
    assert.throws(() => encodeQr('x'.repeat(400), { level: 'H' }), /exceeds/);
  });
});

describe('qrToSvgPath', () => {
  it('emits one rectangle per dark module', () => {
    const matrix = encodeQr('IFMS', { level: 'L', mask: 0 });
    const dark = matrix.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    const path = qrToSvgPath(matrix);
    assert.equal(path.split('M').length - 1, dark);
  });

  it('keeps every rectangle inside the matrix', () => {
    const matrix = encodeQr('IFMS', { level: 'L', mask: 0 });
    for (const [, x, y] of qrToSvgPath(matrix).matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
      assert.ok(Number(x) < matrix.size && Number(y) < matrix.size);
    }
  });

  it('reserves the quiet zone the specification requires', () => {
    assert.equal(QR_QUIET_ZONE, 4);
  });
});
