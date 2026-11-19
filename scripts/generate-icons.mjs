#!/usr/bin/env node
/**
 * Builds every image the application wears, from one source: `img/logo.jpeg`.
 *
 * One source, because a brand kept in six files is a brand that is wrong in
 * five of them. Change the logo, run this, and the launcher icon, the tab icon,
 * the sign-in screen and the shell header all move together.
 *
 * Every output carries a hash of the source in its filename, and that is not
 * decoration. An installed application's icon is drawn by the operating system
 * from a copy it took at install time; replacing the bytes behind the same URL
 * changes nothing on the phone. A new URL is what makes it a new icon — so the
 * manifest is written from here too, and the two can never disagree.
 *
 *     node scripts/generate-icons.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(root, 'img', 'logo.jpeg');
const outDir = path.join(root, 'public', 'brand');

/** The emblem sits on a white page; the icons keep that white behind it. */
const PAGE = { r: 255, g: 255, b: 255, alpha: 1 };

let source;
try {
  source = readFileSync(SOURCE);
} catch {
  console.error(`\n  Missing ${path.relative(root, SOURCE)} — nothing to generate from.\n`);
  process.exit(1);
}

/*
 * The look the images are drawn in, beside the logo itself: changing either is
 * a new set of URLs, so a phone that installed the old set picks up the new.
 */
const LOOK = 'splash-navy-1';

const VERSION = createHash('sha256').update(source).update(LOOK).digest('hex').slice(0, 8);

/**
 * The opening screen's colours: a deep navy drawn from the emblem's own ring,
 * darker at the edges. The page's splash (`app-splash.tsx`) uses the same two.
 */
const SPLASH_EDGE = '#041331';
const SPLASH_CENTRE = '#0d2f74';

/** How large the emblem is drawn on the opening screen, in CSS pixels — the page's splash matches it. */
const SPLASH_EMBLEM = 132;

/**
 * The emblem alone, square and edge to edge.
 *
 * Trimming the page away first means the logo fills its icon rather than
 * floating in whatever margin the original file happened to have.
 */
const emblem = await sharp(source).trim({ threshold: 20 }).toBuffer();
const { width, height } = await sharp(emblem).metadata();
const side = Math.max(width, height);

/** A circular cut, so the emblem can sit on any colour without a white box. */
function circleMask(size) {
  const r = size / 2;
  return Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r}" fill="#fff"/></svg>`,
  );
}

/**
 * One icon.
 *
 * `coverage` is how much of the square the emblem occupies. A maskable icon
 * gives it 62% — inside the safe zone every launcher respects — because the
 * rest may be cropped to a circle or a squircle without warning.
 */
async function icon(size, { coverage = 1, background = PAGE, round = false }) {
  const inner = Math.round(size * coverage);

  const scaled = await sharp(emblem)
    .resize(inner, inner, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .toBuffer();

  const cut = round
    ? await sharp(scaled)
        .composite([{ input: circleMask(inner), blend: 'dest-in' }])
        .png()
        .toBuffer()
    : scaled;

  const offset = Math.round((size - inner) / 2);

  return sharp({
    create: { width: size, height: size, channels: 4, background },
  })
    .composite([{ input: cut, top: offset, left: offset }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const OUTPUTS = [
  /*
   * The plain icons: the round emblem with nothing behind it. Android draws
   * its opening screen from these, on the manifest's background colour — a
   * white square on the navy would be the box the emblem came out of.
   */
  { name: `icon-192.${VERSION}.png`, size: 192, coverage: 0.96, background: TRANSPARENT, round: true },
  { name: `icon-512.${VERSION}.png`, size: 512, coverage: 0.96, background: TRANSPARENT, round: true },
  // The launcher's icons, which it may crop to any shape: white behind, as before.
  { name: `icon-maskable-192.${VERSION}.png`, size: 192, coverage: 0.62 },
  { name: `icon-maskable-512.${VERSION}.png`, size: 512, coverage: 0.62 },
  // iOS reads this from a link tag, applies its own rounding, and composites
  // onto white — so it is drawn full-bleed rather than with corners of its own.
  { name: `apple-touch-icon.${VERSION}.png`, size: 180, coverage: 0.88 },

  // The browser tab. Circular and transparent so it reads on a dark tab strip.
  { name: `favicon-32.${VERSION}.png`, size: 32, coverage: 1, background: TRANSPARENT, round: true },
  { name: `favicon-64.${VERSION}.png`, size: 64, coverage: 1, background: TRANSPARENT, round: true },

  // For the interface itself — the sign-in screen and the shell header, where
  // it sits on a coloured surface and must not carry a white square with it.
  { name: `logo.${VERSION}.png`, size: 512, coverage: 1, background: TRANSPARENT, round: true },
  { name: `logo-128.${VERSION}.png`, size: 128, coverage: 1, background: TRANSPARENT, round: true },
];

mkdirSync(outDir, { recursive: true });

// Anything from an earlier logo goes, or the directory accumulates one dead set
// per revision and it stops being obvious which is live.
for (const file of readdirSync(outDir)) {
  if (!file.includes(VERSION)) unlinkSync(path.join(outDir, file));
}

for (const output of OUTPUTS) {
  const png = await icon(output.size, output);
  writeFileSync(path.join(outDir, output.name), png);
  console.log(`  ${output.name}  ${output.size}×${output.size}  ${(png.length / 1024).toFixed(1)} kB`);
}

// ---------------------------------------------------------------------------
// The opening screens iOS shows while an installed app starts
// ---------------------------------------------------------------------------

/*
 * iOS ignores the manifest's colours and shows a white page unless it is given
 * a picture for the exact screen it is on. One per iPhone screen size, in
 * portrait: the navy, the emblem at the centre — where the page's own splash
 * draws it, at the same size, so the hand-over is not seen.
 *
 *   [CSS width, CSS height, pixel ratio]
 */
const SCREENS = [
  [440, 956, 3], // 16 Pro Max
  [402, 874, 3], // 16 Pro
  [430, 932, 3], // 15 Pro Max, 15 Plus, 14 Pro Max
  [393, 852, 3], // 15, 15 Pro, 14 Pro, 16
  [428, 926, 3], // 14 Plus, 13 Pro Max, 12 Pro Max
  [390, 844, 3], // 14, 13, 13 Pro, 12, 12 Pro
  [375, 812, 3], // 13 mini, 12 mini, 11 Pro, XS, X
  [414, 896, 3], // 11 Pro Max, XS Max
  [414, 896, 2], // 11, XR
  [414, 736, 3], // 8 Plus
  [375, 667, 2], // SE, 8
];

const roundEmblem = async (size) =>
  sharp(
    await sharp(emblem)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .toBuffer(),
  )
    .composite([{ input: circleMask(size), blend: 'dest-in' }])
    .png()
    .toBuffer();

// The emblem for the page's own splash: drawn at three times its size for a phone's screen, and light.
const markName = `splash-mark.${VERSION}.webp`;
const markFile = await sharp(await roundEmblem(SPLASH_EMBLEM * 3)).webp({ quality: 88, alphaQuality: 100 }).toBuffer();
writeFileSync(path.join(outDir, markName), markFile);
console.log(`  ${markName}  ${(markFile.length / 1024).toFixed(1)} kB`);

const splashes = [];
for (const [cssWidth, cssHeight, ratio] of SCREENS) {
  const width = cssWidth * ratio;
  const height = cssHeight * ratio;
  const mark = SPLASH_EMBLEM * ratio;
  const glow = Math.round(mark * 1.9);
  const backdrop = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg" cx="50%" cy="50%" r="75%">
          <stop offset="0" stop-color="${SPLASH_CENTRE}"/>
          <stop offset="1" stop-color="${SPLASH_EDGE}"/>
        </radialGradient>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stop-color="#5b8cff" stop-opacity="0.35"/>
          <stop offset="1" stop-color="#5b8cff" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <circle cx="${width / 2}" cy="${height / 2}" r="${glow / 2}" fill="url(#glow)"/>
    </svg>`,
  );
  const name = `splash-${width}x${height}.${VERSION}.png`;
  const png = await sharp(backdrop)
    .composite([
      {
        input: await roundEmblem(mark),
        top: Math.round((height - mark) / 2),
        left: Math.round((width - mark) / 2),
      },
    ])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  writeFileSync(path.join(outDir, name), png);
  splashes.push({
    url: `/brand/${name}`,
    media: `(device-width: ${cssWidth}px) and (device-height: ${cssHeight}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait)`,
  });
  console.log(`  ${name}  ${(png.length / 1024).toFixed(1)} kB`);
}

// ---------------------------------------------------------------------------
// The manifest, written here so its icon URLs cannot drift from the files
// ---------------------------------------------------------------------------

const manifest = {
  id: '/',
  name: 'انترنشونال',
  short_name: 'انترنشونال',
  description: 'أدوات الشباك ودفتر الأستاذ: التصريف والحوالات و USDT.',
  lang: 'ar',
  dir: 'rtl',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  display_override: ['standalone', 'minimal-ui'],
  orientation: 'portrait-primary',
  // The opening screen Android draws: the emblem on the navy, not on white.
  background_color: SPLASH_EDGE,
  theme_color: '#0b3b8c',
  categories: ['finance', 'business'],
  icons: [
    { src: `/brand/icon-192.${VERSION}.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `/brand/icon-512.${VERSION}.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    {
      src: `/brand/icon-maskable-192.${VERSION}.png`,
      sizes: '192x192',
      type: 'image/png',
      purpose: 'maskable',
    },
    {
      src: `/brand/icon-maskable-512.${VERSION}.png`,
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
  shortcuts: [
    { name: 'ماكينة التصريف', url: '/counter/machine' },
    { name: 'الحوالات', url: '/counter/remittance' },
    { name: 'استلام USDT', url: '/counter/usdt' },
  ],
};

writeFileSync(
  path.join(root, 'public', 'manifest.webmanifest'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

// And the paths the interface imports, so a component never spells one out.
writeFileSync(
  path.join(root, 'src', 'app', '_shell', 'brand.ts'),
  `/**
 * Generated by \`scripts/generate-icons.mjs\` — do not edit.
 *
 * The filenames carry a hash of \`img/logo.jpeg\`, so replacing the logo changes
 * every URL and no browser or launcher can serve the previous one.
 */

export const BRAND_VERSION = '${VERSION}';

export const BRAND = {
  logo: '/brand/logo.${VERSION}.png',
  logoSmall: '/brand/logo-128.${VERSION}.png',
  favicon32: '/brand/favicon-32.${VERSION}.png',
  favicon64: '/brand/favicon-64.${VERSION}.png',
  appleTouchIcon: '/brand/apple-touch-icon.${VERSION}.png',
} as const;

/** The opening screen: its colours, the emblem's size on it, and iOS's picture for each iPhone. */
export const SPLASH = {
  edge: '${SPLASH_EDGE}',
  centre: '${SPLASH_CENTRE}',
  emblem: ${SPLASH_EMBLEM},
  mark: '/brand/${markName}',
  images: ${JSON.stringify(splashes, null, 2).replace(/\n/g, '\n  ')},
} as const;
`,
);

console.log(`\n${OUTPUTS.length} image(s) written to public/brand, plus the manifest. Version ${VERSION}.`);
