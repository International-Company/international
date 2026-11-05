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

/** A currency as the office says it: دولار, not USD. Any other keeps its code. */
const CURRENCY_WORDS: Record<string, string> = {
  USD: 'دولار',
  ILS: 'شيكل',
  JOD: 'دينار',
};

export function currencyWord(code: string): string {
  return CURRENCY_WORDS[code] ?? code;
}

/** 1,250 دولار or 1,250.5 شيكل — whole when it is whole, never more than two places. */
export function formatAmount({ currency, amount }: Amount): string {
  return `${formatFigure(amount)} ${currencyWord(currency)}`;
}

/** The figure alone: 1,250 or -1,250.5. */
export function formatFigure(amount: bigint): string {
  const negative = amount < 0n;
  const [whole = '0', fraction = ''] = toDecimalString(negative ? -amount : amount, 2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = fraction.replace(/0+$/, '');
  return `${negative ? '-' : ''}${grouped}${cents ? `.${cents}` : ''}`;
}

const list = (amounts: Amount[]) => amounts.map(formatAmount).join(' + ') || '—';

/** Amounts added up per currency, in the order each first appears. */
export function sumAmounts(amounts: Amount[]): Amount[] {
  const totals = new Map<string, bigint>();
  for (const { currency, amount } of amounts) {
    totals.set(currency, (totals.get(currency) ?? 0n) + amount);
  }
  return [...totals].map(([currency, amount]) => ({ currency, amount }));
}

export const METHOD_WORDS = { CASH: 'نقدي', BANK: 'بنكي' } as const;

/** Part of a side's total, and how it moved. Coins are neither notes nor a transfer. */
export interface MethodAmount extends Amount {
  method: keyof typeof METHOD_WORDS | null;
}

/** A side's total told apart: the bank's share as recorded, the rest in notes. */
export function byMethod(total: Amount[], bank: Amount[]): MethodAmount[] {
  return total.flatMap(({ currency, amount }): MethodAmount[] => {
    if (currency === 'USDT') return [{ currency, amount, method: null }];
    const viaBank = bank.find((entry) => entry.currency === currency)?.amount ?? 0n;
    const parts: MethodAmount[] = [
      { currency, amount: amount - viaBank, method: 'CASH' },
      { currency, amount: viaBank, method: 'BANK' },
    ];
    return parts.filter((part) => part.amount > 0n);
  });
}

const methodList = (amounts: MethodAmount[]) =>
  amounts
    .map((entry) =>
      entry.method ? `${formatAmount(entry)} ${METHOD_WORDS[entry.method]}` : formatAmount(entry),
    )
    .join(' + ') || '—';

export type CountKind =
  | 'BUY'
  | 'SELL'
  | 'USDT_RECEIVE'
  | 'USDT_SEND'
  | 'WALLET_TOPUP'
  | 'REMITTANCE_OUT';

export const KIND_WORDS: Record<CountKind, string> = {
  BUY: 'شراء (صرافة)',
  SELL: 'بيع (صرافة)',
  USDT_RECEIVE: 'استلام يواس',
  USDT_SEND: 'سحب / بيع يواس',
  WALLET_TOPUP: 'إيداع في محفظة',
  REMITTANCE_OUT: 'حوالات صادرة',
};

/** The heading of each kind's own list of deals. */
export const MOVE_WORDS: Record<CountKind, string> = {
  BUY: 'حركات الشراء (صرافة)',
  SELL: 'حركات البيع (صرافة)',
  USDT_RECEIVE: 'شراء يواس (استلام)',
  USDT_SEND: 'بيع يواس (سحب وبيع)',
  WALLET_TOPUP: 'الإيداع في محفظة',
  REMITTANCE_OUT: 'الحوالات الصادرة',
};

/** One deal in a kind's list. */
export interface Move {
  at: string;
  /** What was bought or sold: the dollars, the coins. */
  goods: Amount;
  /** Per unit of the goods, read off the amounts themselves. */
  price: string | null;
  /** What it was bought or sold for. */
  counter: Amount;
  customer: string | null;
  /** Paid or paid out by transfer, in whole or in part. */
  byBank: boolean;
}

/** A price to four places at most: 3.65, not 3.6500. */
function priceText(goods: bigint, counter: bigint): string | null {
  if (goods <= 0n || counter <= 0n) return null;
  const tenThousandths = (counter * 10_000n + goods / 2n) / goods;
  const whole = tenThousandths / 10_000n;
  const fraction = (tenThousandths % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * A deal as its kind's list reads it. A purchase has the goods on what the
 * customer handed over, a sale on what they took away, so the same column means
 * the same thing in every list.
 */
export function moveOf(
  kind: CountKind,
  deal: {
    at: string;
    fromCurrency: string;
    fromAmount: bigint;
    toCurrency: string;
    toAmount: bigint;
    customer: string | null;
    intakeBank: bigint;
    payoutBank: bigint;
  },
): Move {
  const from = { currency: deal.fromCurrency, amount: deal.fromAmount };
  const to = { currency: deal.toCurrency, amount: deal.toAmount };
  const goodsFirst = kind === 'BUY' || kind === 'USDT_RECEIVE' || kind === 'REMITTANCE_OUT';
  const goods = goodsFirst ? from : to;
  const counter = goodsFirst ? to : from;
  return {
    at: deal.at,
    goods,
    counter,
    // One currency on both sides: there is no price to read, only the gap.
    price:
      kind === 'REMITTANCE_OUT' || kind === 'WALLET_TOPUP'
        ? null
        : priceText(goods.amount, counter.amount),
    customer: deal.customer,
    byBank: deal.intakeBank > 0n || deal.payoutBank > 0n,
  };
}

export interface TellerDay {
  teller: string;
  day: string;
  /** The hour the figures were read at, for "so far". */
  asOf: string;
  cash: { currency: string; opening: bigint; in: bigint; out: bigint; closing: bigint }[];
  openingSet: boolean;
  groups: {
    kind: CountKind;
    count: number;
    received: Amount[];
    paid: Amount[];
    /** The shares of those that went through the bank. */
    receivedBank: Amount[];
    paidBank: Amount[];
    /** Each deal that stands, in the order they were made. */
    moves: Move[];
  }[];
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
        `${currencyWord(row.currency)}: افتتاح ${at(row.opening)} | داخل ${at(row.in)} | خارج ${at(row.out)}`,
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
        `   استلم: ${methodList(byMethod(group.received, group.receivedBank))}`,
        `   دفع: ${methodList(byMethod(group.paid, group.paidBank))}`,
      );
    }
    for (const group of active) {
      lines.push('', `▫️ ${MOVE_WORDS[group.kind]}`);
      for (const move of group.moves) {
        const price = move.price ? ` × ${move.price}` : '';
        const who = move.customer ? ` — ${move.customer}` : '';
        const bank = move.byBank ? ' — بنكي' : '';
        lines.push(
          `${move.at}: ${formatAmount(move.goods)}${price} = ${formatAmount(move.counter)}${bank}${who}`,
        );
      }
      const goods = sumAmounts(group.moves.map((move) => move.goods));
      const counter = sumAmounts(group.moves.map((move) => move.counter));
      lines.push(`المجموع: ${list(goods)} = ${list(counter)}`);
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
