import 'server-only';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { BRAND } from '@/app/_shell/brand';
import {
  byMethod,
  currencyWord,
  formatFigure,
  KIND_WORDS,
  METHOD_WORDS,
  MOVE_WORDS,
  sumAmounts,
  type Amount,
  type CountKind,
  type MethodAmount,
  type Move,
  type TellerDay,
} from './report-command';

/**
 * The teller's day as a picture, for the group.
 *
 * Drawn as SVG and rasterised by resvg, which shapes Arabic itself — joined
 * letters, right to left — from a font shipped in the repository. Nothing
 * here depends on what the server has installed: the slim image has no Arabic
 * fonts at all, and a report drawn in boxes is worse than none.
 */

const FONTS = ['Tajawal-Regular.ttf', 'Tajawal-Bold.ttf'].map((file) =>
  path.join(process.cwd(), 'src', 'assets', 'fonts', file),
);

/**
 * The office's logo, as the page embeds it — read once. A logo that cannot be
 * read leaves the heading without it rather than the report unsent.
 */
let logo: string | null | undefined;
function logoDataUri(): string | null {
  if (logo !== undefined) return logo;
  try {
    const file = readFileSync(path.join(process.cwd(), 'public', BRAND.logo));
    logo = `data:image/png;base64,${file.toString('base64')}`;
  } catch {
    logo = null;
  }
  return logo;
}

const WIDTH = 900;
const PAD = 36;
const RIGHT = WIDTH - PAD;
const LINE = 34;

const COLOR = {
  page: '#f6f7f9',
  card: '#ffffff',
  ink: '#111827',
  soft: '#6b7280',
  rule: '#e5e7eb',
  brand: '#123a8f',
  brandSoft: '#e0e9ff',
  /** The heading's quieter line, on the brand blue. */
  onBrand: '#c9d8ff',
  stripe: '#f9fafb',
  warn: '#b45309',
  danger: '#b91c1c',
};

const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Text {
  x: number;
  y: number;
  text: string;
  size?: number;
  bold?: boolean;
  color?: string;
  /** Where x is: the right edge (Arabic, default), the left, or the middle. */
  anchor?: 'end' | 'start' | 'middle';
}

const text = ({ x, y, text: value, size = 22, bold, color = COLOR.ink, anchor = 'end' }: Text) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="${color}" text-anchor="${anchor}">${escape(value)}</text>`;

/**
 * One line in a cell. An amount carries its currency word apart from its
 * figure, because the two cannot share a line of text: a figure after an
 * Arabic word is taken into the Arabic run by the bidi rules, so no order of
 * writing puts «5,000» to the right of «شيكل». Drawn as two pieces — the
 * figure at the column's edge, the word in a fixed slot beside it — it reads
 * «5,000 شيكل» right to left, and the words line up down the column.
 */
interface Line {
  text: string;
  unit?: string;
  /** The figure that matters in its row. */
  strong?: boolean;
}

/** Room left for a figure before its currency word. */
const FIGURE_SLOT = 118;

const amount = (value: Amount, strong = false): Line => ({
  text: formatFigure(value.amount),
  unit: currencyWord(value.currency),
  strong,
});

/** An amount with how it moved beside its currency word: «5,000 شيكل بنكي». */
const methodAmount = (value: MethodAmount): Line => ({
  text: formatFigure(value.amount),
  unit: value.method
    ? `${currencyWord(value.currency)} ${METHOD_WORDS[value.method]}`
    : currencyWord(value.currency),
});

/** A table: a header row, then rows that may run to several lines each, the last perhaps a total. */
function table(
  top: number,
  columns: { title: string; right: number }[],
  rows: (string | Line)[][][],
  slot = FIGURE_SLOT,
  totalled = false,
): { svg: string; bottom: number } {
  const parts: string[] = [];
  parts.push(
    `<rect x="${PAD}" y="${top}" width="${WIDTH - 2 * PAD}" height="${LINE + 10}" rx="10" fill="${COLOR.brandSoft}"/>`,
  );
  for (const column of columns) {
    parts.push(
      text({
        x: column.right,
        y: top + LINE - 4,
        text: column.title,
        size: 19,
        bold: true,
        color: COLOR.brand,
      }),
    );
  }
  let y = top + LINE + 10;
  rows.forEach((row, index) => {
    const height = Math.max(...row.map((cell) => cell.length), 1) * LINE + 12;
    const total = totalled && index === rows.length - 1;
    if (total || index % 2 === 1) {
      parts.push(
        `<rect x="${PAD}" y="${y}" width="${WIDTH - 2 * PAD}" height="${height}" fill="${total ? COLOR.brandSoft : COLOR.stripe}"/>`,
      );
    }
    row.forEach((cell, column) => {
      cell.forEach((entry, n) => {
        const line = typeof entry === 'string' ? { text: entry } : entry;
        const right = columns[column]!.right;
        const at = y + LINE * (n + 1) - 4;
        // A box below zero is the one figure nobody should miss.
        const color = line.strong
          ? line.text.startsWith('-')
            ? COLOR.danger
            : COLOR.brand
          : COLOR.ink;
        const bold = column === 0 || line.strong;
        parts.push(text({ x: right, y: at, text: line.text, size: 21, bold, color }));
        if (line.unit) {
          parts.push(
            text({ x: right - slot, y: at, text: line.unit, size: 19, color: COLOR.soft }),
          );
        }
      });
    });
    y += height;
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${RIGHT}" y2="${y}" stroke="${COLOR.rule}"/>`);
  });
  return { svg: parts.join(''), bottom: y };
}

/** The band across the top of every picture, and the page it is when there are several. */
function heading(
  day: TellerDay,
  office: string,
  logoUri: string | null,
  page: { index: number; of: number },
): string[] {
  const parts: string[] = [];
  const HEAD = 150;
  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEAD}" fill="${COLOR.brand}"/>`);
  parts.push(
    text({ x: RIGHT, y: 68, text: `جرد ${day.teller}`, size: 40, bold: true, color: '#ffffff' }),
  );
  parts.push(
    text({
      x: RIGHT,
      y: 110,
      text: `${day.day}  —  حتى الساعة ${day.asOf}`,
      size: 22,
      color: COLOR.onBrand,
    }),
  );
  const mark = 118;
  if (logoUri) {
    // A white disc behind it, so the logo's blue rim does not melt into the heading.
    parts.push(
      `<circle cx="${PAD - 8 + mark / 2}" cy="${HEAD / 2}" r="${mark / 2 + 3}" fill="#ffffff"/>`,
    );
    parts.push(
      `<image x="${PAD - 8}" y="${(HEAD - mark) / 2}" width="${mark}" height="${mark}" href="${logoUri}"/>`,
    );
  }
  const left = logoUri ? PAD + mark + 6 : PAD;
  if (office) {
    parts.push(
      text({
        x: left,
        y: HEAD / 2 + 8,
        text: office,
        size: 22,
        bold: true,
        color: '#ffffff',
        anchor: 'start',
      }),
    );
  }
  if (page.of > 1) {
    parts.push(
      text({
        x: left,
        y: HEAD / 2 + 38,
        text: `صفحة ${page.index + 1} من ${page.of}`,
        size: 18,
        color: COLOR.onBrand,
        anchor: 'start',
      }),
    );
  }
  return parts;
}

const sideLines = (total: Amount[], bank: Amount[]): (string | Line)[] => {
  const parts = byMethod(total, bank);
  return parts.length ? parts.map(methodAmount) : ['—'];
};

/** What opens the first picture: the box, then each kind's totals. */
function summary(day: TellerDay, top: number): { parts: string[]; y: number } {
  const parts: string[] = [];
  let y = top;

  parts.push(text({ x: RIGHT, y, text: 'الصندوق', size: 28, bold: true }));
  y += 16;
  const cash = day.cash.filter(
    (row) => row.opening !== 0n || row.in !== 0n || row.out !== 0n || row.closing !== 0n,
  );
  if (cash.length === 0) {
    y += 30;
    parts.push(text({ x: RIGHT, y, text: 'لا حركة نقدية اليوم', color: COLOR.soft }));
    y += 20;
  } else {
    const box = table(
      y,
      [
        { title: 'العملة', right: RIGHT - 12 },
        { title: 'افتتاح', right: RIGHT - 150 },
        { title: 'داخل', right: RIGHT - 330 },
        { title: 'خارج', right: RIGHT - 510 },
        { title: 'المتبقي', right: RIGHT - 690 + 20 },
      ],
      cash.map((row) => [
        [currencyWord(row.currency)],
        [formatFigure(row.opening)],
        [formatFigure(row.in)],
        [formatFigure(row.out)],
        [{ text: formatFigure(row.closing), strong: true }],
      ]),
    );
    parts.push(box.svg);
    y = box.bottom;
  }
  if (!day.openingSet) {
    y += 32;
    parts.push(
      text({
        x: RIGHT,
        y,
        text: 'لم يُدخل التلر رصيد الافتتاح لليوم',
        size: 19,
        color: COLOR.warn,
      }),
    );
  }

  y += 62;
  parts.push(text({ x: RIGHT, y, text: 'المجاميع', size: 28, bold: true }));
  y += 16;
  const groups = day.groups.filter((group) => group.count > 0);
  if (groups.length === 0) {
    y += 30;
    parts.push(text({ x: RIGHT, y, text: 'لا عمليات اليوم', color: COLOR.soft }));
    y += 20;
  } else {
    const deals = table(
      y,
      [
        { title: 'النوع', right: RIGHT - 12 },
        { title: 'العدد', right: RIGHT - 250 },
        { title: 'استلم', right: RIGHT - 350 },
        { title: 'دفع', right: RIGHT - 590 },
      ],
      groups.map((group) => [
        [KIND_WORDS[group.kind]],
        [String(group.count)],
        sideLines(group.received, group.receivedBank),
        sideLines(group.paid, group.paidBank),
      ]),
    );
    parts.push(deals.svg);
    y = deals.bottom;
  }
  return { parts, y };
}

/*
 * How many lines fit a picture. WhatsApp shrinks a very tall image until its
 * figures cannot be read, so a long day runs to several rather than one strip.
 * The first picture leaves room for the box and the totals above its lists.
 */
const LINES_ON_FIRST = 22;
const LINES_ON_REST = 28;
/** A list's heading and its column titles take about this many lines between them. */
const LIST_HEADER_LINES = 3;

const NAME_CHARS = 24;

interface ListPart {
  kind: CountKind;
  moves: Move[];
  /** Carries on from the picture before. */
  continued: boolean;
  /** The whole list's sums, on the part that ends it. */
  totals?: { goods: Amount[]; counter: Amount[] };
}

/** Each kind's deals laid out across pictures, split only where a page runs out. */
export function paginate(day: TellerDay): ListPart[][] {
  const pages: ListPart[][] = [[]];
  let room = LINES_ON_FIRST;

  for (const group of day.groups) {
    const totals = {
      goods: sumAmounts(group.moves.map((move) => move.goods)),
      counter: sumAmounts(group.moves.map((move) => move.counter)),
    };
    const totalLines = Math.max(totals.goods.length, totals.counter.length);
    let rest = group.moves;
    let continued = false;
    while (rest.length > 0) {
      // Not worth opening a list for a line or two at the foot of a page, and
      // a total never goes over alone: its last deal goes with it.
      const least = rest.length === 1 ? 1 + totalLines : 2;
      if (room < LIST_HEADER_LINES + least) {
        pages.push([]);
        room = LINES_ON_REST;
      }
      const space = room - LIST_HEADER_LINES;
      const ends = rest.length + totalLines <= space;
      const fits = ends ? rest.length : Math.min(rest.length - 1, space);
      pages[pages.length - 1]!.push({
        kind: group.kind,
        moves: rest.slice(0, fits),
        continued,
        ...(ends ? { totals } : {}),
      });
      room -= LIST_HEADER_LINES + fits + (ends ? totalLines : 0);
      rest = rest.slice(fits);
      continued = true;
    }
  }
  return pages;
}

function list(part: ListPart, top: number): { parts: string[]; y: number } {
  const parts: string[] = [];
  let y = top;
  parts.push(
    text({
      x: RIGHT,
      y,
      text: part.continued ? `${MOVE_WORDS[part.kind]} (تابع)` : MOVE_WORDS[part.kind],
      size: 26,
      bold: true,
    }),
  );
  y += 16;
  const remittance = part.kind === 'REMITTANCE_OUT';
  const wallet = part.kind === 'WALLET_TOPUP';
  const rows = table(
    y,
    [
      { title: 'الوقت', right: RIGHT - 12 },
      { title: remittance ? 'استلمنا' : wallet ? 'أودعنا' : 'المبلغ', right: RIGHT - 95 },
      { title: remittance || wallet ? '' : 'السعر', right: RIGHT - 265 },
      { title: remittance ? 'تسعيرة المراسل' : 'المقابل', right: RIGHT - 350 },
      { title: remittance ? 'ملاحظة' : 'العميل', right: RIGHT - 520 },
    ],
    [
      ...part.moves.map((move) => {
        const name = move.customer?.trim() ?? '';
        // Cut without an ellipsis: the bidi rules would carry it to the wrong end of the line.
        const shown = name.slice(0, NAME_CHARS).trim();
        return [
          [move.at],
          [amount(move.goods)],
          remittance || wallet ? [] : [move.price ?? '—'],
          [amount(move.counter)],
          [[move.byBank ? 'بنكي' : null, shown].filter(Boolean).join(' · ') || '—'],
        ];
      }),
      ...(part.totals
        ? [
            [
              // The short word: the time column is narrow, and the sum beside it can run long.
              ['مجموع'],
              part.totals.goods.map((value) => amount(value, true)),
              [],
              part.totals.counter.map((value) => amount(value, true)),
              [],
            ],
          ]
        : []),
    ],
    86,
    Boolean(part.totals),
  );
  parts.push(rows.svg);
  return { parts, y: rows.bottom };
}

/** Every picture's SVG, in order — exported so a test can read what they say. */
export function reportSvgs(day: TellerDay, office = '', logoUri: string | null = null): string[] {
  const pages = paginate(day);
  return pages.map((lists, index) => {
    const parts = heading(day, office, logoUri, { index, of: pages.length });
    let y = 150 + 44;
    if (index === 0) {
      const opening = summary(day, y);
      parts.push(...opening.parts);
      y = opening.y + 62;
    }
    for (const part of lists) {
      const drawn = list(part, y);
      parts.push(...drawn.parts);
      y = drawn.y + 56;
    }
    const height = y + PAD - 40;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="Tajawal">`,
      `<rect width="${WIDTH}" height="${height}" fill="${COLOR.card}"/>`,
      ...parts,
      '</svg>',
    ].join('');
  });
}

/** The pictures themselves, as PNGs, drawn at twice the size for a sharp phone screen. */
export function reportImages(day: TellerDay, office = ''): Buffer[] {
  return reportSvgs(day, office, logoDataUri()).map((svg) =>
    new Resvg(svg, {
      font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Tajawal' },
      fitTo: { mode: 'width', value: WIDTH * 2 },
      background: COLOR.card,
    })
      .render()
      .asPng(),
  );
}
