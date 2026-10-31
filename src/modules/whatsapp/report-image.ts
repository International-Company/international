import 'server-only';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { formatAmount, KIND_WORDS, type TellerDay } from './report-command';

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
  brand: '#0f766e',
  brandSoft: '#ccfbf1',
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

/** A table: a header row, then rows that may run to several lines each. */
function table(
  top: number,
  columns: { title: string; right: number }[],
  rows: string[][][],
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
    if (index % 2 === 1) {
      parts.push(
        `<rect x="${PAD}" y="${y}" width="${WIDTH - 2 * PAD}" height="${height}" fill="${COLOR.stripe}"/>`,
      );
    }
    row.forEach((cell, column) => {
      cell.forEach((line, n) => {
        // A leading * marks the figure that matters in its row.
        const strong = line.startsWith('*');
        parts.push(
          text({
            x: columns[column]!.right,
            y: y + LINE * (n + 1) - 4,
            text: strong ? line.slice(1) : line,
            size: 21,
            bold: column === 0 || strong,
            // A box below zero is the one figure nobody should miss.
            color: strong ? (line.startsWith('*-') ? COLOR.danger : COLOR.brand) : COLOR.ink,
          }),
        );
      });
    });
    y += height;
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${RIGHT}" y2="${y}" stroke="${COLOR.rule}"/>`);
  });
  return { svg: parts.join(''), bottom: y };
}

/** The SVG the picture is drawn from — exported so a test can read what it says. */
export function reportSvg(day: TellerDay, office = ''): string {
  const parts: string[] = [];
  let y = PAD;

  // Heading.
  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="120" fill="${COLOR.brand}"/>`);
  parts.push(
    text({ x: RIGHT, y: 58, text: `جرد ${day.teller}`, size: 38, bold: true, color: '#ffffff' }),
  );
  parts.push(
    text({
      x: RIGHT,
      y: 98,
      text: `${day.day}  —  حتى الساعة ${day.asOf}`,
      size: 22,
      color: '#ccfbf1',
    }),
  );
  if (office)
    parts.push(text({ x: PAD, y: 58, text: office, size: 20, color: '#ccfbf1', anchor: 'start' }));
  y = 160;

  // The box.
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
    const at = (currency: string, amount: bigint) => formatAmount({ currency, amount });
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
        [row.currency],
        [at(row.currency, row.opening)],
        [at(row.currency, row.in)],
        [at(row.currency, row.out)],
        [`*${at(row.currency, row.closing)}`],
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

  // The deals.
  y += 62;
  parts.push(text({ x: RIGHT, y, text: 'العمليات', size: 28, bold: true }));
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
        group.received.length ? group.received.map(formatAmount) : ['—'],
        group.paid.length ? group.paid.map(formatAmount) : ['—'],
      ]),
    );
    parts.push(deals.svg);
    y = deals.bottom;
  }

  const height = y + PAD + 10;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" font-family="Tajawal">`,
    `<rect width="${WIDTH}" height="${height}" fill="${COLOR.card}"/>`,
    ...parts,
    '</svg>',
  ].join('');
}

/** The picture itself, as a PNG, drawn at twice the size for a sharp phone screen. */
export function reportImage(day: TellerDay, office = ''): Buffer {
  const rendered = new Resvg(reportSvg(day, office), {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Tajawal' },
    fitTo: { mode: 'width', value: WIDTH * 2 },
    background: COLOR.card,
  }).render();
  return rendered.asPng();
}
