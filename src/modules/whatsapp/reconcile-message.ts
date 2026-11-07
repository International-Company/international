import { formatAmount, formatFigure, sumAmounts, type Amount } from './report-command';

/**
 * «#مطابقة» — each group's own reconciliation, in words.
 *
 * A group is answered about what it is sent and nothing else: the group that
 * hears of exchange and USDT deals is told what the office owes by bank, the
 * remittances group what went out today, the TikTok group what was withdrawn,
 * and the group sent each sale's deposit the coins it was asked to send.
 * A group that hears of several gets each in its own section of one message.
 *
 * The pure half, kept apart from WhatsApp and the database so every figure and
 * every line can be pinned by a test.
 */

/** What a group types to be answered. */
export const RECONCILE_CODE = '#مطابقة';

/**
 * Whether a message is the code, as a phone really types it: with a space after
 * the #, a ه for the ة, extra spaces, or the invisible direction marks an
 * Arabic keyboard puts in. Words after it are not the code.
 */
export function isReconcileCode(text: string | null | undefined): boolean {
  if (!text) return false;
  const plain = text
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\uff03/g, '#')
    .trim();
  return /^#\s*مطابق[ةه]$/.test(plain);
}

/** A deal the office pays out, in whole or in part, by bank transfer. */
export interface BankDue {
  kind: 'EXCHANGE' | 'USDT';
  currency: string;
  /** The bank part of the payout. */
  amount: bigint;
  /** The account it leaves from, when one was named. */
  channel: string | null;
}

/** A remittance sent today, as its group was told of it. */
export interface RemittanceSent {
  phone: string | null;
  /** What reaches the beneficiary when it was said (3000 جنيه), else what was paid. */
  amount: bigint;
  /** A word (جنيه) for a sum said for the beneficiary; else a currency code. */
  unit: string;
}

/** A USDT sale's deposit, as its group was sent it: the coins and where they go. */
export interface UsdtDeposit {
  amount: bigint;
  address: string | null;
}

/** A TikTok withdrawal that stands. */
export interface TiktokWithdrawn {
  amount: bigint;
  currency: string;
  /** The shekels handed over; nothing on one recorded before they were. */
  payoutAmount: bigint;
  /** The pounds the photo shows, when the teller typed them. */
  egpAmount: bigint | null;
}

export interface GroupReconciliation {
  day: string;
  asOf: string;
  /** Each present only when the group is sent that kind. */
  bank?: BankDue[];
  remittances?: RemittanceSent[];
  tiktok?: TiktokWithdrawn[];
  deposits?: UsdtDeposit[];
}

interface Section {
  title: string;
  icon: string;
  lines: string[];
}

const KIND_WORDS: Record<BankDue['kind'], string> = { EXCHANGE: 'الصرافة', USDT: 'USDT' };

/** «عملية واحدة»-style counting, short: 1 عملية, 4 عمليات. */
const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const sumList = (amounts: Amount[]) => amounts.map(formatAmount).join(' + ') || '0';

/** A sum in a unit that is already a word (جنيه) or a currency code (ILS → شيكل). */
const unitAmount = (amount: bigint, unit: string) =>
  /^[A-Z]{3,4}$/.test(unit)
    ? formatAmount({ currency: unit, amount })
    : `${formatFigure(amount)} ${unit}`;

function bankSection(dues: BankDue[]): Section {
  const title = 'المستحق البنكي';
  if (dues.length === 0) return { title, icon: '🏦', lines: ['لا مستحقات بنكية اليوم'] };

  const lines: string[] = [];
  for (const kind of ['EXCHANGE', 'USDT'] as const) {
    const ofKind = dues.filter((due) => due.kind === kind);
    if (ofKind.length === 0) continue;
    lines.push(
      `▫️ ${KIND_WORDS[kind]}: ${counted(ofKind.length, 'عملية', 'عمليات')} — ${sumList(sumAmounts(ofKind))}`,
    );
  }

  // By the account it leaves from, those named first in the order they appear.
  const channels = [...new Set(dues.map((due) => due.channel?.trim() || ''))].sort(
    (a, b) => Number(a === '') - Number(b === ''),
  );
  if (channels.length > 1 || channels[0] !== '') {
    lines.push('', 'حسب الحساب:');
    for (const channel of channels) {
      const of = dues.filter((due) => (due.channel?.trim() || '') === channel);
      lines.push(`• ${channel || 'بلا حساب محدد'}: ${sumList(sumAmounts(of))}`);
    }
  }

  lines.push('', `*المجموع: ${sumList(sumAmounts(dues))}*`);
  return { title, icon: '🏦', lines };
}

function remittanceSection(sent: RemittanceSent[]): Section {
  const title = 'الحوالات الصادرة';
  if (sent.length === 0) return { title, icon: '💸', lines: ['لا حوالات صادرة اليوم'] };

  const lines = sent.map(
    (row, index) =>
      `${index + 1}. ${[row.phone?.trim(), unitAmount(row.amount, row.unit)].filter(Boolean).join(' — ')}`,
  );
  const totals = new Map<string, bigint>();
  for (const row of sent) totals.set(row.unit, (totals.get(row.unit) ?? 0n) + row.amount);
  lines.push(
    '',
    `عدد الحوالات: ${sent.length}`,
    `*المجموع: ${[...totals].map(([unit, amount]) => unitAmount(amount, unit)).join(' + ')}*`,
  );
  return { title, icon: '💸', lines };
}

/** An address cut to its ends, enough to find it by: TXab12…9fZk. */
const shortAddress = (address: string) =>
  address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

function depositSection(deposits: UsdtDeposit[]): Section {
  const title = 'إيداعات USDT';
  if (deposits.length === 0) return { title, icon: '🪙', lines: ['لا إيداعات USDT اليوم'] };
  const lines = deposits.map(
    (row, index) =>
      `${index + 1}. ${[formatAmount({ currency: 'USDT', amount: row.amount }), row.address?.trim() && shortAddress(row.address.trim())].filter(Boolean).join(' — ')}`,
  );
  const total = deposits.reduce((sum, row) => sum + row.amount, 0n);
  lines.push(
    '',
    `عدد الإيداعات: ${deposits.length}`,
    `*المجموع: ${formatAmount({ currency: 'USDT', amount: total })}*`,
  );
  return { title, icon: '🪙', lines };
}

function tiktokSection(rows: TiktokWithdrawn[]): Section {
  const dollars = sumAmounts(rows.map(({ currency, amount }) => ({ currency, amount })));
  const shekels = rows.reduce((sum, row) => sum + row.payoutAmount, 0n);
  const pounds = rows.reduce((sum, row) => sum + (row.egpAmount ?? 0n), 0n);
  const blank = rows.filter((row) => !row.egpAmount).length;
  const lines = [
    `عدد السحوبات: ${rows.length}`,
    `مجموع الشيكل: *${formatAmount({ currency: 'ILS', amount: shekels })}*`,
    `مجموع الدولار: *${dollars.length ? sumList(dollars) : formatAmount({ currency: 'USD', amount: 0n })}*`,
    `مجموع الجنيه: *${formatAmount({ currency: 'EGP', amount: pounds })}*`,
  ];
  // So a short pound total is not taken for the whole day's.
  if (blank > 0) lines.push(`(${counted(blank, 'سحب', 'سحوبات')} بلا مبلغ بالجنيه)`);
  return { title: 'تيكتوك', icon: '🎵', lines };
}

/** The answer, or null when the group is sent none of these. */
export function composeGroupReconciliation(input: GroupReconciliation): string | null {
  const sections = [
    input.bank && bankSection(input.bank),
    input.deposits && depositSection(input.deposits),
    input.remittances && remittanceSection(input.remittances),
    input.tiktok && tiktokSection(input.tiktok),
  ].filter((section): section is Section => Boolean(section));
  if (sections.length === 0) return null;

  const stamp = `${input.day} — حتى الساعة ${input.asOf}`;
  // One section: its name heads the message. Several: each under its own.
  if (sections.length === 1) {
    const [only] = sections as [Section];
    return [`📋 *مطابقة ${only.title}*`, stamp, '', ...only.lines].join('\n');
  }
  return [
    '📋 *مطابقة اليوم*',
    stamp,
    ...sections.flatMap((section) => ['', `${section.icon} *${section.title}*`, ...section.lines]),
  ].join('\n');
}
