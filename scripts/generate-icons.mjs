#!/usr/bin/env node
/**
 * Renders the application icons from the same mark as `public/favicon.svg`.
 *
 * PNG rather than SVG because an installed app's icon is drawn by the operating
 * system, and Android, iOS and Windows all want raster. And generated rather
 * than committed by hand so the mark has one definition: changing the favicon
 * and forgetting the launcher icon is exactly the kind of drift that shows up
 * on somebody's home screen a year later.
 *
 * No image library. A PNG is a handful of length-prefixed chunks around a
 * zlib-deflated bitmap, and Node ships zlib — so pulling in a dependency to
 * draw four circles would cost more than it saves.
 *
 *     node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'icons');

const BRAND = [0x1d, 0x4e, 0xd8];
const WHITE = [0xff, 0xff, 0xff];

// ---------------------------------------------------------------------------
// The mark, in the favicon's own 32×32 coordinates
// ---------------------------------------------------------------------------

/** Three ledger rules and a full stop — the same shapes as favicon.svg. */
const STROKE = 2.5;
const MARK = {
  bars: [
    [8, 11, 24, 11],
    [8, 16, 19, 16],
    [8, 21, 24, 21],
  ],
  dot: [23, 21, 2.5],
};

/** Distance from a point to a line segment. */
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Whether a point in 32-space falls on the white mark. */
function onMark(x, y) {
  for (const [x1, y1, x2, y2] of MARK.bars) {
    // Round caps, so the capsule is "within half a stroke of the segment".
    if (distanceToSegment(x, y, x1, y1, x2, y2) <= STROKE / 2) return true;
  }
  const [cx, cy, r] = MARK.dot;
  return Math.hypot(x - cx, y - cy) <= r;
}

/**
 * Whether a point falls inside a rounded square of the given radius.
 *
 * The standard signed distance to a rounded box. The obvious shortcut — treat
 * the corners as circles and everything else as inside — is what the first
 * version of this did, and it cut the straight edges away between the corners:
 * a point in the top band has `dy > 0` while `dx <= 0`, which is inside the
 * shape but outside any corner circle.
 */
function inRoundedSquare(x, y, size, radius) {
  const dx = Math.abs(x - size / 2) - (size / 2 - radius);
  const dy = Math.abs(y - size / 2) - (size / 2 - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside <= radius;
}

/**
 * Draws one icon.
 *
 * `maskable` means the launcher may crop it to a circle or a squircle, so the
 * background bleeds to every edge and the mark shrinks into the safe zone.
 * Getting this wrong is what produces the icons with their corners sliced off.
 */
function draw(size, { maskable }) {
  const pixels = Buffer.alloc(size * size * 4);
  const SAMPLES = 4; // 4×4 supersampling, which is enough for shapes this simple
  const scale = size / 32;

  // The mark occupies the middle 62% of a maskable icon — inside the safe zone
  // every platform respects — and the whole of a normal one.
  const markScale = maskable ? 0.62 : 1;
  const markOffset = ((1 - markScale) * 32) / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let inside = 0;
      let onGlyph = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;

          if (maskable || inRoundedSquare(x, y, size, 6 * scale)) inside++;

          const mx = (x / scale - markOffset) / markScale;
          const my = (y / scale - markOffset) / markScale;
          if (onMark(mx, my)) onGlyph++;
        }
      }

      const total = SAMPLES * SAMPLES;
      const coverage = inside / total;
      const glyph = Math.min(onGlyph / total, coverage);

      // The glyph is composited over the brand square, and the square over
      // nothing — so the alpha is the square's coverage and the colour is the
      // glyph mixed into the brand.
      const offset = (py * size + px) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const mixed = coverage === 0 ? 0 : (BRAND[channel] * (coverage - glyph) + WHITE[channel] * glyph) / coverage;
        pixels[offset + channel] = Math.round(mixed);
      }
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }

  return pixels;
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10..12 are compression, filter and interlace — all zero.

  // Every scanline carries a leading filter byte. Filter 0 (none) keeps this
  // readable; the shapes compress well enough that a smarter filter would save
  // a few hundred bytes on a file nobody downloads twice.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------

mkdirSync(outDir, { recursive: true });

const ICONS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-192.png', size: 192, maskable: true },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  // iOS ignores the manifest and reads this one from a link tag. It also
  // composites onto a white background, so it is drawn full-bleed like a
  // maskable icon rather than with its own rounded corners on top of Apple's.
  { file: 'apple-touch-icon.png', size: 180, maskable: true },
];

for (const { file, size, maskable } of ICONS) {
  const png = encodePng(size, draw(size, { maskable }));
  writeFileSync(path.join(outDir, file), png);
  console.log(`  ${file}  ${size}×${size}  ${(png.length / 1024).toFixed(1)} kB`);
}

console.log(`\n${ICONS.length} icon(s) written to public/icons.`);
