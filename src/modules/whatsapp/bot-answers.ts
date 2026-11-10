import { toDecimalString } from '@/core/money/money';
import { calculationLines, type BotCalculation } from './bot-calc';
import type { BotProfile } from './bot-profile';
import { foldName, currencyWord } from './report-command';
import type { PriceSheet, SheetRate } from './price-sheet';

/**
 * Every word the private number sends, chosen and not composed.
 *
 * The assistant only says what a message is asking for. What goes back is the
 * office's own text, or figures from its own prices, so nothing can be added,
 * reworded or misquoted, and an account number is exactly what was typed.
 */

export const INTENTS = [
  'greeting',
  'faq',
  'about',
  'price',
  'extra',
  'calculation',
  'remittance',
  'account_list',
  'account',
  'handover',
  'none',
] as const;

export interface BotPick {
  intent: (typeof INTENTS)[number];
  faq_index: number | null;
  extra_index: number | null;
  account_index: number | null;
  currencies: string[];
  channel: 'CASH' | 'BANK' | null;
  destination: string | null;
  calculation: BotCalculation | null;
  wants_staff: boolean;
  summary: string | null;
}

export interface Rendered {
  /** Null when the office has given it nothing to say: it stays silent. */
  reply: string | null;
  handover: boolean;
  summary: string | null;
}

export const SAY_TO_STAFF = 'موظف من المكتب رح يتواصل معك بخصوص طلبك قريباً.';
const SAY_CLOSED = 'المكتب مغلق الآن. موظف رح يتواصل معك وقت الدوام.';
const SAY_HELLO = 'أهلاً وسهلاً، كيف بقدر أساعدك؟';
const SAY_PRICE_CHANGES = 'والسعر ممكن يتغير.';

const figure = (value: bigint, places: number) =>
  toDecimalString(value, places).replace(/\.?0+$/, '') || '0';

const CHANNEL_WORDS: Record<string, string> = { CASH: 'نقدي', BROKER: 'تحويل بنكي' };

function rateLine(rate: SheetRate): string | null {
  const sides = [
    rate.buyRate > 0n ? `نشتري بـ ${figure(rate.buyRate, 4)}` : null,
    rate.sellRate > 0n ? `نبيع بـ ${figure(rate.sellRate, 4)}` : null,
  ].filter(Boolean);
  if (sides.length === 0) return null;
  return `${currencyWord(rate.baseCode)} مقابل ${currencyWord(rate.quoteCode)} (${CHANNEL_WORDS[rate.channel] ?? rate.channel}): ${sides.join('، ')}`;
}

function priceLines(pick: BotPick, sheet: PriceSheet): string[] {
  const channel = pick.channel === 'CASH' ? 'CASH' : pick.channel === 'BANK' ? 'BROKER' : null;
  const rates = sheet.rates
    .filter((rate) => pick.currencies.includes(rate.baseCode))
    .filter((rate) => channel === null || rate.channel === channel)
    .map(rateLine)
    .filter((line): line is string => line !== null);
  const usdt = pick.currencies.includes('USDT')
    ? [
        channel !== 'BROKER' && sheet.usdtForCashDollars > 0
          ? `USDT مقابل دولار نقدي: نخصم ${sheet.usdtForCashDollars}%`
          : null,
        channel !== 'CASH' && sheet.usdtForBankDollars > 0
          ? `USDT مقابل دولار بتحويل بنكي: نخصم ${sheet.usdtForBankDollars}%`
          : null,
      ].filter((line): line is string => line !== null)
    : [];
  return [...rates, ...usdt];
}

function remittanceLines(destination: string | null, sheet: PriceSheet): string[] {
  const wanted = destination ? foldName(destination) : '';
  return sheet.remittances
    .filter((row) => !wanted || foldName(row.destination).includes(wanted))
    .map((row) => {
      const fee =
        row.chargeKind === 'PERCENT'
          ? `${figure(row.chargeValue, 4)}%`
          : `${figure(row.chargeValue, 2)} ${currencyWord(row.currency)}`;
      return `الحوالة إلى ${row.destination} (${currencyWord(row.currency)}): الرسوم ${fee}`;
    });
}

const withPriceNote = (lines: string[]) =>
  lines.length > 0 ? [...lines, SAY_PRICE_CHANGES].join('\n') : null;

const accountText = (row: BotProfile['accounts'][number]) =>
  [row.bank, `الاسم: ${row.name}`, `رقم الحساب: ${row.account}`].join('\n');

function replyFor(pick: BotPick, profile: BotProfile, sheet: PriceSheet): string | null {
  switch (pick.intent) {
    case 'greeting':
      return profile.welcome || SAY_HELLO;
    case 'about':
      return profile.about || null;
    case 'faq':
      return pick.faq_index === null ? null : (profile.faqs[pick.faq_index]?.answer ?? null);
    case 'price':
      return withPriceNote(priceLines(pick, sheet));
    case 'remittance':
      return withPriceNote(remittanceLines(pick.destination, sheet));
    case 'calculation':
      return pick.calculation
        ? withPriceNote(calculationLines(pick.calculation, sheet.rates))
        : null;
    case 'extra': {
      const row = pick.extra_index === null ? undefined : sheet.extra?.[pick.extra_index];
      if (!row) return null;
      const sides = [
        row.buy ? `نشتري بـ ${row.buy}` : null,
        row.sell ? `نبيع بـ ${row.sell}` : null,
      ].filter(Boolean);
      return withPriceNote([`${row.item}: ${sides.join('، ')}`]);
    }
    case 'account': {
      const row = pick.account_index === null ? undefined : profile.accounts[pick.account_index];
      return row ? accountText(row) : null;
    }
    case 'account_list':
      if (profile.accounts.length === 0) return null;
      if (profile.accounts.length === 1) return accountText(profile.accounts[0]!);
      return ['أي بنك بدك؟', ...profile.accounts.map((row) => `• ${row.bank}`)].join('\n');
    case 'handover':
    case 'none':
      return null;
  }
}

/** Turns what was asked for into what is sent. */
export function renderAnswer(
  pick: BotPick,
  profile: BotProfile,
  sheet: PriceSheet,
  open: boolean,
): Rendered {
  const toStaff = pick.intent === 'handover' || pick.wants_staff;
  const answer = replyFor(pick, profile, sheet);
  const staffWords = open ? SAY_TO_STAFF : SAY_CLOSED;
  return {
    reply: toStaff ? [answer, staffWords].filter(Boolean).join('\n') : answer,
    handover: toStaff,
    summary: pick.summary,
  };
}

/** What the assistant may choose between, and nothing it could repeat of value. */
export function composeChoices(profile: BotProfile, sheet: PriceSheet): string {
  const numbered = (items: string[]) => items.map((item, index) => `${index}: ${item}`).join('\n');
  return [
    `Questions the office has answered (faq_index):\n${numbered(profile.faqs.map((row) => row.question)) || 'none'}`,
    `Banks the office has accounts at (account_index):\n${numbered(profile.accounts.map((row) => row.bank)) || 'none'}`,
    `Other priced items (extra_index):\n${numbered((sheet.extra ?? []).map((row) => row.item)) || 'none'}`,
    `Currencies with prices: ${[...new Set(sheet.rates.map((rate) => rate.baseCode))].join(', ') || 'none'}`,
    `Remittance destinations: ${[...new Set(sheet.remittances.map((row) => row.destination))].join(', ') || 'none'}`,
    `The office has written about itself: ${profile.about ? 'yes' : 'no'}`,
  ].join('\n\n');
}
