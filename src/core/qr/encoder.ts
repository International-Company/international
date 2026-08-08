/**
 * QR Code encoder — ISO/IEC 18004, byte mode, versions 1 to 10.
 *
 * A wallet address shown as a QR is the one place in this system where a
 * rendering bug moves real money to a stranger: the customer scans what we draw
 * and their wallet sends to whatever it decodes. So this is written from the
 * specification rather than wrapped around a package, and its output is frozen
 * in `encoder.test.ts` against matrices cross-checked with an independent
 * implementation.
 *
 * Byte mode only. Addresses and payment URIs are ASCII, and the alphanumeric and
 * kanji modes would add branches that nothing here would ever take.
 *
 * Versions 1-10 carry up to 271 bytes at level M, which is far more than any
 * address or payment URI needs. Refusing beyond that is deliberate: a payload
 * that large is a bug upstream, not a bigger symbol.
 */

export type ErrorCorrectionLevel = 'L' | 'M' | 'Q' | 'H';

/** A square grid of modules. `true` is dark. */
export interface QrMatrix {
  size: number;
  modules: boolean[][];
  version: number;
  level: ErrorCorrectionLevel;
}

const MAX_VERSION = 10;

/** Total codewords (data + error correction) per version. */
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

/** Error-correction codewords per block, indexed [level][version - 1]. */
const EC_PER_BLOCK: Record<ErrorCorrectionLevel, number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

/** Number of error-correction blocks, indexed [level][version - 1]. */
const BLOCK_COUNT: Record<ErrorCorrectionLevel, number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT_CENTRES: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Two-bit level indicator used in the format information. */
const LEVEL_BITS: Record<ErrorCorrectionLevel, number> = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

// ---------------------------------------------------------------------------
// GF(256) arithmetic for Reed-Solomon
// ---------------------------------------------------------------------------

/**
 * Log and antilog tables over GF(256) with the QR primitive polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11D). Built once — the alternative is a
 * multiply-by-shifting inner loop inside the generator convolution.
 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let index = 0; index < 255; index++) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index++) EXP[index] = EXP[index - 255]!;
}

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/**
 * The generator polynomial for `degree` error-correction codewords:
 * (x - α⁰)(x - α¹)…(x - α^degree-1), coefficients from the highest power down.
 *
 * Multiplying by (x + α^i) shifts the existing coefficients up one power and
 * adds α^i times each in place — so the shift lands on `position + 1` and the
 * scaled term on `position`, not the other way round. Reversing the two is
 * invisible at degree 1, where both orders give x + 1, and produces a perfectly
 * well-formed symbol that no scanner can read from degree 2 up.
 */
function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let index = 0; index < degree; index++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let position = 0; position < poly.length; position++) {
      next[position] = (next[position] ?? 0) ^ poly[position]!;
      next[position + 1] = (next[position + 1] ?? 0) ^ gfMultiply(poly[position]!, EXP[index]!);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of `data` divided by the generator — the error-correction block. */
function errorCorrection(data: number[], ecCount: number): number[] {
  const generator = generatorPolynomial(ecCount);
  const remainder = new Array<number>(ecCount).fill(0);

  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < ecCount; index++) {
      remainder[index] = remainder[index]! ^ gfMultiply(generator[index + 1]!, factor);
    }
  }

  return remainder;
}

// ---------------------------------------------------------------------------
// Bit assembly
// ---------------------------------------------------------------------------

class BitBuffer {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index--) {
      this.bits.push((value >>> index) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  /** Pads to a byte boundary and returns the codewords. */
  toCodewords(): number[] {
    const codewords: number[] = [];
    for (let index = 0; index < this.bits.length; index += 8) {
      let byte = 0;
      for (let offset = 0; offset < 8; offset++) {
        byte = (byte << 1) | (this.bits[index + offset] ?? 0);
      }
      codewords.push(byte);
    }
    return codewords;
  }
}

/** Data capacity in codewords for a version and level. */
function dataCodewordCount(version: number, level: ErrorCorrectionLevel): number {
  return (
    TOTAL_CODEWORDS[version - 1]! -
    EC_PER_BLOCK[level][version - 1]! * BLOCK_COUNT[level][version - 1]!
  );
}

/** The smallest version that holds `byteLength` bytes at this level. */
function smallestVersion(byteLength: number, level: ErrorCorrectionLevel): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    // 4 mode bits + the character count indicator, which widens at version 10.
    const headerBits = 4 + (version < 10 ? 8 : 16);
    const capacityBits = dataCodewordCount(version, level) * 8;
    if (headerBits + byteLength * 8 <= capacityBits) return version;
  }
  throw new Error(
    `QR payload of ${byteLength} bytes exceeds version ${MAX_VERSION} at level ${level}`,
  );
}

/** Mode indicator, length, payload, terminator and the alternating pad bytes. */
function encodeData(bytes: Uint8Array, version: number, level: ErrorCorrectionLevel): number[] {
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4);
  buffer.push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) buffer.push(byte, 8);

  const capacityBits = dataCodewordCount(version, level) * 8;
  buffer.push(0, Math.min(4, capacityBits - buffer.length));

  // Pad to the next byte boundary, then with the two bytes the spec names.
  if (buffer.length % 8 !== 0) buffer.push(0, 8 - (buffer.length % 8));

  const codewords = buffer.toCodewords();
  const target = dataCodewordCount(version, level);
  for (let index = 0; codewords.length < target; index++) {
    codewords.push(index % 2 === 0 ? 0xec : 0x11);
  }

  return codewords;
}

/**
 * Splits the data into blocks, appends each block's error correction, and
 * interleaves both — a burst of damage then lands across many blocks instead of
 * destroying one, which is the whole point of the block structure.
 */
function interleave(data: number[], version: number, level: ErrorCorrectionLevel): number[] {
  const blocks = BLOCK_COUNT[level][version - 1]!;
  const ecCount = EC_PER_BLOCK[level][version - 1]!;

  const shortLength = Math.floor(data.length / blocks);
  const longBlocks = data.length % blocks;

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  for (let index = 0; index < blocks; index++) {
    const length = shortLength + (index >= blocks - longBlocks ? 1 : 0);
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, ecCount));
  }

  const result: number[] = [];
  const longest = shortLength + (longBlocks > 0 ? 1 : 0);

  for (let column = 0; column < longest; column++) {
    for (const block of dataBlocks) {
      if (column < block.length) result.push(block[column]!);
    }
  }
  for (let column = 0; column < ecCount; column++) {
    for (const block of ecBlocks) result.push(block[column]!);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Module placement
// ---------------------------------------------------------------------------

interface Grid {
  modules: (boolean | null)[][];
  reserved: boolean[][];
  size: number;
}

function blankGrid(size: number): Grid {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function place(grid: Grid, row: number, column: number, dark: boolean): void {
  grid.modules[row]![column] = dark;
  grid.reserved[row]![column] = true;
}

/** The three 7×7 position-detection patterns and their separators. */
function drawFinders(grid: Grid): void {
  const corners = [
    [0, 0],
    [0, grid.size - 7],
    [grid.size - 7, 0],
  ];

  for (const [top, left] of corners) {
    for (let row = -1; row <= 7; row++) {
      for (let column = -1; column <= 7; column++) {
        const r = top! + row;
        const c = left! + column;
        if (r < 0 || r >= grid.size || c < 0 || c >= grid.size) continue;

        const onRing = row === 0 || row === 6 || column === 0 || column === 6;
        const inCore = row >= 2 && row <= 4 && column >= 2 && column <= 4;
        const inside = row >= 0 && row <= 6 && column >= 0 && column <= 6;

        place(grid, r, c, inside && (onRing || inCore));
      }
    }
  }
}

function drawTiming(grid: Grid): void {
  for (let index = 8; index < grid.size - 8; index++) {
    const dark = index % 2 === 0;
    place(grid, 6, index, dark);
    place(grid, index, 6, dark);
  }
}

function drawAlignment(grid: Grid, version: number): void {
  const centres = ALIGNMENT_CENTRES[version - 1]!;

  for (const row of centres) {
    for (const column of centres) {
      // The three corners already carry finder patterns.
      const atFinder =
        (row === 6 && column === 6) ||
        (row === 6 && column === grid.size - 7) ||
        (row === grid.size - 7 && column === 6);
      if (atFinder) continue;

      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          place(grid, row + dr, column + dc, ring !== 1);
        }
      }
    }
  }
}

/** Reserves the format and version areas so data skips them. */
function reserveInformation(grid: Grid, version: number): void {
  for (let index = 0; index < 9; index++) {
    grid.reserved[8]![index] = true;
    grid.reserved[index]![8] = true;
  }
  for (let index = 0; index < 8; index++) {
    grid.reserved[8]![grid.size - 1 - index] = true;
    grid.reserved[grid.size - 1 - index]![8] = true;
  }

  if (version >= 7) {
    for (let row = 0; row < 6; row++) {
      for (let column = 0; column < 3; column++) {
        grid.reserved[row]![grid.size - 11 + column] = true;
        grid.reserved[grid.size - 11 + column]![row] = true;
      }
    }
  }
}

/**
 * Lays the codeword bits along the zigzag the spec defines: two-module columns
 * walked from the bottom-right, alternating direction, skipping the vertical
 * timing column and everything already reserved.
 */
function placeData(grid: Grid, codewords: number[]): void {
  let bitIndex = 0;
  let upward = true;

  for (let right = grid.size - 1; right >= 1; right -= 2) {
    // The timing column is not part of the zigzag.
    if (right === 6) right = 5;

    for (let step = 0; step < grid.size; step++) {
      const row = upward ? grid.size - 1 - step : step;

      for (let offset = 0; offset < 2; offset++) {
        const column = right - offset;
        if (grid.reserved[row]![column]) continue;

        const byte = codewords[bitIndex >>> 3] ?? 0;
        const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
        grid.modules[row]![column] = bit === 1;
        bitIndex++;
      }
    }

    upward = !upward;
  }
}

const MASKS: ((row: number, column: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number): boolean[][] {
  const rule = MASKS[mask]!;
  return grid.modules.map((row, r) =>
    row.map((value, c) => {
      const dark = value ?? false;
      return grid.reserved[r]![c] ? dark : dark !== rule(r, c);
    }),
  );
}

/** BCH(15,5) format information, masked with the constant the spec fixes. */
function formatBits(level: ErrorCorrectionLevel, mask: number): number {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let value = data << 10;

  for (let index = 14; index >= 10; index--) {
    if ((value >>> index) & 1) value ^= 0b10100110111 << (index - 10);
  }

  return ((data << 10) | value) ^ 0b101010000010010;
}

/** BCH(18,6) version information, present from version 7. */
function versionBits(version: number): number {
  let value = version << 12;
  for (let index = 17; index >= 12; index--) {
    if ((value >>> index) & 1) value ^= 0b1111100100101 << (index - 12);
  }
  return (version << 12) | value;
}

function drawFormat(modules: boolean[][], size: number, level: ErrorCorrectionLevel, mask: number): void {
  const bits = formatBits(level, mask);

  for (let index = 0; index < 15; index++) {
    const dark = ((bits >>> index) & 1) === 1;

    // Copy one: around the top-left finder, skipping the timing row and column.
    if (index < 6) modules[index]![8] = dark;
    else if (index < 8) modules[index + 1]![8] = dark;
    else if (index === 8) modules[8]![7] = dark;
    else modules[8]![14 - index] = dark;

    // Copy two: split between the other two finders.
    if (index < 8) modules[8]![size - 1 - index] = dark;
    else modules[size - 15 + index]![8] = dark;
  }

  // Always dark, and never part of the format information.
  modules[size - 8]![8] = true;
}

function drawVersion(modules: boolean[][], size: number, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);

  for (let index = 0; index < 18; index++) {
    const dark = ((bits >>> index) & 1) === 1;
    const row = Math.floor(index / 3);
    const column = size - 11 + (index % 3);
    modules[row]![column] = dark;
    modules[column]![row] = dark;
  }
}

// ---------------------------------------------------------------------------
// Mask selection
// ---------------------------------------------------------------------------

/**
 * The four penalty rules from the specification. The mask with the lowest total
 * is chosen, which is what keeps a symbol from developing large blank areas or
 * patterns a scanner mistakes for a finder.
 */
function penalty(modules: boolean[][], size: number): number {
  let score = 0;

  // Rule 1 — runs of five or more identical modules in a row or column.
  for (let index = 0; index < size; index++) {
    for (const line of [modules[index]!, modules.map((row) => row[index]!)]) {
      let run = 1;
      for (let position = 1; position < size; position++) {
        if (line[position] === line[position - 1]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
    }
  }

  // Rule 2 — every 2×2 block of one colour.
  for (let row = 0; row < size - 1; row++) {
    for (let column = 0; column < size - 1; column++) {
      const value = modules[row]![column];
      if (
        value === modules[row]![column + 1] &&
        value === modules[row + 1]![column] &&
        value === modules[row + 1]![column + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 3 — the finder-like 1:1:3:1:1 sequence with four light modules beside it.
  const patternA = [true, false, true, true, true, false, true, false, false, false, false];
  const patternB = [false, false, false, false, true, false, true, true, true, false, true];

  const matches = (line: boolean[], start: number, pattern: boolean[]): boolean =>
    pattern.every((value, offset) => line[start + offset] === value);

  for (let index = 0; index < size; index++) {
    for (const line of [modules[index]!, modules.map((row) => row[index]!)]) {
      for (let start = 0; start + 11 <= size; start++) {
        if (matches(line, start, patternA) || matches(line, start, patternB)) score += 40;
      }
    }
  }

  // Rule 4 — deviation from an even split of dark and light.
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EncodeOptions {
  level?: ErrorCorrectionLevel;
  /** Forces a version; by default the smallest that fits is used. */
  minVersion?: number;
  /** Forces a mask instead of scoring all eight. Used by the tests. */
  mask?: number;
}

/**
 * Encodes text as a QR matrix.
 *
 * Level Q by default rather than the more common L or M: this symbol is read off
 * a screen at a counter, at an angle, sometimes with a fingerprint across it.
 * The extra redundancy costs a slightly denser grid and buys a scan that works
 * the first time.
 */
export function encodeQr(text: string, options: EncodeOptions = {}): QrMatrix {
  const level = options.level ?? 'Q';
  const bytes = new TextEncoder().encode(text);

  if (bytes.length === 0) throw new Error('QR payload is empty');

  const version = Math.max(smallestVersion(bytes.length, level), options.minVersion ?? 1);
  if (version > MAX_VERSION) {
    throw new Error(`QR version ${version} exceeds the supported maximum of ${MAX_VERSION}`);
  }

  const codewords = interleave(encodeData(bytes, version, level), version, level);

  const size = version * 4 + 17;
  const grid = blankGrid(size);

  drawFinders(grid);
  drawAlignment(grid, version);
  drawTiming(grid);
  reserveInformation(grid, version);
  placeData(grid, codewords);

  let best: boolean[][] | null = null;
  let bestScore = Infinity;

  const candidates = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];

  for (const mask of candidates) {
    const candidate = applyMask(grid, mask);
    drawFormat(candidate, size, level, mask);
    drawVersion(candidate, size, version);

    const score = penalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { size, modules: best!, version, level };
}

/**
 * Renders a matrix as an SVG path.
 *
 * One path of rectangles rather than one element per module: a version 10 symbol
 * is 3,364 modules, and that many DOM nodes is visibly slow to paint on the
 * tablet a counter actually uses.
 */
export function qrToSvgPath(matrix: QrMatrix): string {
  const parts: string[] = [];

  for (let row = 0; row < matrix.size; row++) {
    for (let column = 0; column < matrix.size; column++) {
      if (matrix.modules[row]![column]) parts.push(`M${column} ${row}h1v1h-1z`);
    }
  }

  return parts.join('');
}

/** The quiet zone the specification requires around the symbol. */
export const QR_QUIET_ZONE = 4;
