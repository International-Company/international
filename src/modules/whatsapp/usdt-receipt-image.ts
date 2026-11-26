import 'server-only';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { BRAND } from '@/app/_shell/brand';

/**
 * The receipt a customer is sent on WhatsApp when their USDT is taken in: the
 * office's mark, what arrived, what they get for it and how, and when.
 *
 * Drawn as SVG and rasterised by resvg from the font shipped in the repository,
 * as the teller's report is. A figure never shares a line with Arabic words —
 * the bidi rules would reorder them — so values are written in Latin letters
 * and digits alone (1,000 USDT · 3,650 ILS) in their own column.
 */

const FONTS = ['Tajawal-Regular.ttf', 'Tajawal-Bold.ttf'].map((file) =>
  path.join(process.cwd(), 'src', 'assets', 'fonts', file),
);

let logo: string | null | undefined;
function logoDataUri(): string | null {
  if (logo !== undefined) return logo;
  try {
    logo = `data:image/png;base64,${readFileSync(path.join(process.cwd(), 'public', BRAND.logo)).toString('base64')}`;
  } catch {
    logo = null;
  }
  return logo;
}

export interface UsdtReceipt {
  office: string;
  customer: string | null;
  /** What arrived: 1,000 */
  coins: string;
  token: string;
  network: string | null;
  /** What they get in all, and in which money. */
  total: string;
  currency: string;
  /** Paid in cash, and by transfer — each only when used. */
  cash: string | null;
  bank: { amount: string; channel: string | null; account: string | null } | null;
  /** Already in the office's time: 26/11/2026 · 14:20 */
  when: string;
}

const W = 760;
const PAD = 44;
const RIGHT = W - PAD;
const C = {
  page: '#f3f5f9',
  card: '#ffffff',
  ink: '#0f172a',
  soft: '#64748b',
  faint: '#94a3b8',
  rule: '#e2e8f0',
  brand: '#0d2f74',
  brand2: '#1d4ed8',
  green: '#059669',
  greenSoft: '#d1fae5',
  stripe: '#f8fafc',
};

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const t = (
  x: number,
  y: number,
  value: string,
  size: number,
  colour: string,
  options: { bold?: boolean; anchor?: 'start' | 'middle' | 'end'; spacing?: number } = {},
) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${options.bold ? 700 : 400}" fill="${colour}" text-anchor="${
    options.anchor ?? 'end'
  }"${options.spacing ? ` letter-spacing="${options.spacing}"` : ''}>${esc(value)}</text>`;

/** A label on the right, its value in Latin figures on the left. */
function row(y: number, label: string, value: string, options: { strong?: boolean; striped?: boolean; colour?: string } = {}) {
  const parts: string[] = [];
  if (options.striped) parts.push(`<rect x="${PAD}" y="${y - 34}" width="${W - PAD * 2}" height="52" rx="12" fill="${C.stripe}"/>`);
  parts.push(t(RIGHT - 18, y, label, 22, C.soft));
  parts.push(t(PAD + 18, y, value, options.strong ? 30 : 24, options.colour ?? C.ink, { bold: true, anchor: 'start' }));
  return parts.join('');
}

export function usdtReceiptSvg(receipt: UsdtReceipt, logoUri: string | null = logoDataUri()): string {
  const parts: string[] = [];
  let y = 0;

  // The heading: the office's mark and name on its blue.
  const HEAD = 150;
  parts.push(
    `<defs><linearGradient id="head" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.brand}"/><stop offset="1" stop-color="${C.brand2}"/></linearGradient></defs>`,
    `<rect x="0" y="0" width="${W}" height="${HEAD}" fill="url(#head)"/>`,
  );
  const mark = 84;
  if (logoUri) {
    parts.push(
      `<rect x="${RIGHT - mark - 4}" y="${(HEAD - mark) / 2 - 4}" width="${mark + 8}" height="${mark + 8}" rx="22" fill="#ffffff"/>`,
      `<image x="${RIGHT - mark}" y="${(HEAD - mark) / 2}" width="${mark}" height="${mark}" href="${logoUri}"/>`,
    );
  }
  const nameRight = logoUri ? RIGHT - mark - 26 : RIGHT;
  parts.push(t(nameRight, 68, receipt.office || 'إيصال', 32, '#ffffff', { bold: true }));
  parts.push(t(nameRight, 106, 'إيصال استلام', 22, '#c7d7fe'));
  y = HEAD;

  // The amount taken in, large, under a tick.
  y += 70;
  parts.push(
    `<circle cx="${W / 2}" cy="${y}" r="36" fill="${C.greenSoft}"/>`,
    `<path d="M ${W / 2 - 16} ${y + 1} L ${W / 2 - 4} ${y + 13} L ${W / 2 + 18} ${y - 12}" stroke="${C.green}" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  );
  y += 82;
  parts.push(t(W / 2, y, 'تم استلام المبلغ بنجاح', 26, C.green, { bold: true, anchor: 'middle' }));
  y += 76;
  parts.push(t(W / 2, y, `${receipt.coins} ${receipt.token}`, 64, C.ink, { bold: true, anchor: 'middle' }));
  if (receipt.network) {
    y += 46;
    const label = receipt.network;
    const width = label.length * 13 + 48;
    parts.push(
      `<rect x="${W / 2 - width / 2}" y="${y - 28}" width="${width}" height="40" rx="20" fill="${C.stripe}" stroke="${C.rule}"/>`,
      t(W / 2, y, label, 20, C.soft, { bold: true, anchor: 'middle', spacing: 1 }),
    );
  }

  // What they get for it.
  y += 44;
  parts.push(`<line x1="${PAD}" y1="${y}" x2="${RIGHT}" y2="${y}" stroke="${C.rule}" stroke-width="2" stroke-dasharray="8 8"/>`);
  y += 62;
  parts.push(
    `<rect x="${PAD}" y="${y - 44}" width="${W - PAD * 2}" height="72" rx="16" fill="${C.greenSoft}"/>`,
    t(RIGHT - 22, y, 'المبلغ المستحق لك', 24, C.green, { bold: true }),
    t(PAD + 22, y + 2, `${receipt.total} ${receipt.currency}`, 36, C.green, { bold: true, anchor: 'start' }),
  );
  y += 30;
  let striped = false;
  if (receipt.cash) {
    y += 54;
    parts.push(row(y, 'نقداً من الصندوق', `${receipt.cash} ${receipt.currency}`, { striped }));
    striped = !striped;
  }
  if (receipt.bank) {
    y += 54;
    parts.push(
      row(y, receipt.bank.channel ? `تحويل إلى ${receipt.bank.channel}` : 'تحويل بنكي', `${receipt.bank.amount} ${receipt.currency}`, { striped }),
    );
    striped = !striped;
    if (receipt.bank.account) {
      y += 54;
      parts.push(row(y, 'رقم الحساب', receipt.bank.account, { striped }));
      striped = !striped;
    }
  }

  // Whose, and when.
  y += 40;
  parts.push(`<line x1="${PAD}" y1="${y}" x2="${RIGHT}" y2="${y}" stroke="${C.rule}" stroke-width="2"/>`);
  if (receipt.customer) {
    y += 54;
    parts.push(t(RIGHT - 18, y, 'العميل', 22, C.soft), t(PAD + 18, y, receipt.customer, 24, C.ink, { bold: true, anchor: 'start' }));
  }
  y += 54;
  parts.push(t(RIGHT - 18, y, 'التاريخ', 22, C.soft), t(PAD + 18, y, receipt.when, 24, C.ink, { bold: true, anchor: 'start' }));

  // The foot.
  y += 50;
  const FOOT = 74;
  parts.push(
    `<rect x="0" y="${y}" width="${W}" height="${FOOT}" fill="${C.stripe}"/>`,
    `<rect x="0" y="${y}" width="${W}" height="2" fill="${C.rule}"/>`,
    t(W / 2, y + 46, `شكراً لتعاملك معنا${receipt.office ? ` — ${receipt.office}` : ''}`, 22, C.soft, { anchor: 'middle' }),
  );
  y += FOOT;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="Tajawal">`,
    `<rect x="0" y="0" width="${W}" height="${y}" fill="${C.card}"/>`,
    ...parts,
    '</svg>',
  ].join('');
}

/** The receipt as a PNG, drawn at twice its size for a sharp phone screen. */
export function usdtReceiptImage(receipt: UsdtReceipt): Buffer {
  return new Resvg(usdtReceiptSvg(receipt), {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Tajawal' },
    fitTo: { mode: 'width', value: W * 2 },
    background: C.card,
  })
    .render()
    .asPng();
}
