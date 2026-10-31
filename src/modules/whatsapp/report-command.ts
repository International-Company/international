import { normalizeDigits, toDecimalString } from '@/core/money/money';

/**
 * «#جرد أحمد» — a teller's day, asked for from the group.
 *
 * The pure half: what counts as the command, who may send it, which teller a
 * name means, and the words of the answer. Kept apart from WhatsApp and the
 * database so each of those decisions can be tested on its own — the first
 * two are what stand between a group member and the office's books.
 */

/** The teller named after the code, or '' for none; null when it is not the command. */
export function parseCommand(text: string | null | undefined, code: string): string | null {
  const wanted = code.trim().toLowerCase();
  if (!wanted || !text) return null;
  const said = text.trim().replace(/\s+/g, ' ');
  if (!said.toLowerCase().startsWith(wanted)) return null;
  const rest = said.slice(wanted.length);
  // The code as a word of its own: «#جردي» is not «#جرد».
  if (rest && !rest.startsWith(' ')) return null;
  return rest.trim();
}

/**
 * A number reduced to what identifies it: its last nine digits. The same phone
 * arrives as 0597085125 in the settings and 970597085125 from WhatsApp, or 972…
 * — the prefix differs, the subscriber does not.
 */
export function phoneKey(value: string): string {
  return normalizeDigits(value).replace(/\D/g, '').slice(-9);
}

/** Whether a sender is one of the numbers the office allowed. None allowed means nobody. */
export function senderAllowed(phone: string | null, allowed: string): boolean {
  if (!phone) return false;
  const key = phoneKey(phone);
  if (key.length < 9) return false;
  return allowed
    .split(/[,،\n;]/)
    .map((entry) => phoneKey(entry))
    .some((entry) => entry.length === 9 && entry === key);
}

/** Arabic as people type it: one alef, no marks, ta marbuta and alef maqsura folded. */
export function foldName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TellerCandidate {
  id: string;
  username: string;
  fullNameAr: string;
  fullNameEn: string;
}

/**
 * The tellers a name could mean. A whole name, or a username, that matches
 * exactly wins outright, so «أحمد» is not ambiguous merely because «أحمد علي»
 * also works here.
 */
export function matchTellers<T extends TellerCandidate>(query: string, users: T[]): T[] {
  const wanted = foldName(query);
  if (!wanted) return [];
  const exact = users.filter(
    (user) =>
      foldName(user.fullNameAr) === wanted ||
      foldName(user.fullNameEn) === wanted ||
      user.username.toLowerCase() === wanted,
  );
  if (exact.length > 0) return exact;
  return users.filter(
    (user) =>
      foldName(user.fullNameAr).includes(wanted) || foldName(user.fullNameEn).includes(wanted),
  );
}

export interface Amount {
  currency: string;
  amount: bigint;
}

/** 1,250 or 1,250.5 — whole when it is whole, never more than two places. */
export function formatAmount({ currency, amount }: Amount): string {
  const negative = amount < 0n;
  const [whole = '0', fraction = ''] = toDecimalString(negative ? -amount : amount, 2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${grouped}${cents ? `.${cents}` : ''} ${currency}`;
}

const list = (amounts: Amount[]) => amounts.map(formatAmount).join(' + ') || '—';

export type CountKind = 'BUY' | 'SELL' | 'USDT_RECEIVE' | 'USDT_SEND';

export const KIND_WORDS: Record<CountKind, string> = {
  BUY: 'شراء (صرافة)',
  SELL: 'بيع (صرافة)',
  USDT_RECEIVE: 'استلام يواس',
  USDT_SEND: 'سحب / بيع يواس',
};

export interface TellerDay {
  teller: string;
  day: string;
  /** The hour the figures were read at, for "so far". */
  asOf: string;
  cash: { currency: string; opening: bigint; in: bigint; out: bigint; closing: bigint }[];
  openingSet: boolean;
  groups: { kind: CountKind; count: number; received: Amount[]; paid: Amount[] }[];
}

/** The answer, as the group reads it. */
export function composeReport(day: TellerDay): string {
  const lines = [`📊 جرد ${day.teller}`, `${day.day} — حتى الساعة ${day.asOf}`, ''];

  lines.push('💵 الصندوق');
  const cash = day.cash.filter(
    (row) => row.opening !== 0n || row.in !== 0n || row.out !== 0n || row.closing !== 0n,
  );
  if (cash.length === 0) {
    lines.push('لا حركة نقدية اليوم');
  } else {
    for (const row of cash) {
      const at = (amount: bigint) => formatAmount({ currency: row.currency, amount });
      lines.push(
        `${row.currency}: افتتاح ${at(row.opening)} | داخل ${at(row.in)} | خارج ${at(row.out)}`,
        `   المتبقي: *${at(row.closing)}*`,
      );
    }
  }
  if (!day.openingSet) lines.push('(لم يُدخل التلر رصيد الافتتاح لليوم)');

  lines.push('', '📋 العمليات');
  const active = day.groups.filter((group) => group.count > 0);
  if (active.length === 0) {
    lines.push('لا عمليات اليوم');
  } else {
    for (const group of active) {
      lines.push(
        `${KIND_WORDS[group.kind]}: ${group.count} ${group.count === 1 ? 'عملية' : 'عمليات'}`,
        `   استلم: ${list(group.received)}`,
        `   دفع: ${list(group.paid)}`,
      );
    }
  }
  return lines.join('\n');
}

/** How to ask, with who can be asked about — sent for a bare code or a name not found. */
export function composeHelp(code: string, tellers: string[], unknown?: string): string {
  const lines = [
    unknown ? `لم أجد تلر باسم «${unknown}».` : 'اكتب الرمز ثم اسم التلر، مثلاً:',
    unknown ? 'اكتب الرمز ثم اسم التلر، مثلاً:' : '',
    `${code} ${tellers[0] ?? 'أحمد'}`,
  ].filter(Boolean);
  if (tellers.length > 0) lines.push('', 'عملوا اليوم:', ...tellers.map((name) => `• ${name}`));
  return lines.join('\n');
}

/** More than one teller answers to the name. */
export function composeAmbiguous(query: string, names: string[]): string {
  return [`أكثر من تلر باسم «${query}»، حدّد أكثر:`, ...names.map((name) => `• ${name}`)].join(
    '\n',
  );
}
