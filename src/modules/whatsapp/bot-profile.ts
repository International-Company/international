import { z } from 'zod';
import type { PriceSheet, SheetRate } from './price-sheet';

/**
 * What the manager tells the private number's assistant from its own panel:
 * about the office, the answers it should give, its greeting, prices the system
 * does not hold, and which of the system's prices a customer may be told.
 *
 * Things hidden are listed rather than things shown, so a currency or destination
 * added later appears without anyone having to come back here.
 */

export const profileSchema = z.object({
  about: z.string().max(4000).default(''),
  welcome: z.string().max(1000).default(''),
  faqs: z
    .array(z.object({ question: z.string().max(300), answer: z.string().max(1000) }))
    .max(50)
    .default([]),
  extraPrices: z
    .array(
      z.object({
        item: z.string().max(120),
        buy: z.string().max(40).default(''),
        sell: z.string().max(40).default(''),
      }),
    )
    .max(50)
    .default([]),
  show: z
    .object({
      cash: z.boolean().default(true),
      bank: z.boolean().default(true),
      usdt: z.boolean().default(true),
      remittances: z.boolean().default(true),
    })
    .default({}),
  hiddenCurrencies: z.array(z.string().max(8)).max(50).default([]),
  hiddenDestinations: z.array(z.string().max(120)).max(200).default([]),
});

export type BotProfile = z.infer<typeof profileSchema>;

export const emptyProfile = (): BotProfile => profileSchema.parse({});

/** The saved profile; one that cannot be read counts as nothing having been written. */
export function parseProfile(raw: string): BotProfile {
  try {
    return profileSchema.parse(JSON.parse(raw || '{}'));
  } catch {
    return emptyProfile();
  }
}

/** The profile as it is kept: rows left half empty are not rows. */
export function tidyProfile(profile: BotProfile): BotProfile {
  return {
    ...profile,
    about: profile.about.trim(),
    welcome: profile.welcome.trim(),
    faqs: profile.faqs
      .map((row) => ({ question: row.question.trim(), answer: row.answer.trim() }))
      .filter((row) => row.question && row.answer),
    extraPrices: profile.extraPrices
      .map((row) => ({ item: row.item.trim(), buy: row.buy.trim(), sell: row.sell.trim() }))
      .filter((row) => row.item && (row.buy || row.sell)),
  };
}

const isUsdt = (rate: SheetRate) => rate.baseCode === 'USDT' || rate.quoteCode === 'USDT';

/** The system's prices cut down to what the customer may be told. What is cut never reaches the assistant. */
export function visibleSheet(sheet: PriceSheet, profile: BotProfile): PriceSheet {
  const { show, hiddenCurrencies, hiddenDestinations } = profile;
  return {
    rates: sheet.rates.filter((rate) => {
      if (hiddenCurrencies.includes(rate.baseCode) || hiddenCurrencies.includes(rate.quoteCode)) {
        return false;
      }
      if (isUsdt(rate)) return show.usdt;
      return rate.channel === 'CASH' ? show.cash : show.bank;
    }),
    remittances: show.remittances
      ? sheet.remittances.filter((row) => !hiddenDestinations.includes(row.destination))
      : [],
    usdtForCashDollars: show.usdt ? sheet.usdtForCashDollars : 0,
    usdtForBankDollars: show.usdt ? sheet.usdtForBankDollars : 0,
    extra: profile.extraPrices,
  };
}

/** The office's own words, for the assistant to answer from. */
export function composeKnowledge(profile: BotProfile): string {
  return [
    ...(profile.about ? ['Written by the office about itself:', profile.about, ''] : []),
    ...(profile.faqs.length > 0
      ? [
          'Answers the office has prepared. When a customer asks one of these, in any wording, give this answer and do not change its facts:',
          ...profile.faqs.map((row) => `س: ${row.question}\nج: ${row.answer}`),
          '',
        ]
      : []),
  ]
    .join('\n')
    .trim();
}

const GREETINGS = [
  'السلام عليكم ورحمه الله وبركاته',
  'السلام عليكم ورحمه الله',
  'السلام عليكم',
  'سلام عليكم',
  'صباح الخير',
  'صباح النور',
  'مساء الخير',
  'مساء النور',
  'مرحبا',
  'مرحبه',
  'اهلا وسهلا',
  'اهلا',
  'هلا والله',
  'هلا',
  'هاي',
  'سلام',
  'hello',
  'hi',
  'hey',
  'salam',
];

/** Whether a message is a greeting and nothing more. One with a question in it is not. */
export function isGreeting(text: string): boolean {
  let rest = ` ${text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
  if (!rest.trim()) return false;
  for (const greeting of GREETINGS) {
    while (rest.includes(` ${greeting} `)) rest = rest.replace(` ${greeting} `, ' ');
  }
  return !rest.trim();
}

/** The office's own greeting, for the first message of a conversation when it is only hello. */
export function cannedWelcome(
  isFirst: boolean,
  text: string,
  profile: BotProfile,
): string | null {
  return isFirst && profile.welcome && isGreeting(text) ? profile.welcome : null;
}
