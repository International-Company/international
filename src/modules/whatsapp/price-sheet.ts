import { toDecimalString } from '@/core/money/money';
import { foldName } from './report-command';

/**
 * The office's prices in words, as the assistant on the private number is given them.
 *
 * Holds what a customer may be told and nothing else. A remittance row has only
 * what the office charges: what the correspondent charges the office never comes
 * in here, so no question can get it out.
 */

/** The names a currency goes by, as they fold, with the usual slips of the keyboard. */
const CURRENCY_NAMES: Record<string, string> = {
  usdt: 'USDT',
  ustd: 'USDT',
  udst: 'USDT',
  usdtt: 'USDT',
  'usd t': 'USDT',
  tether: 'USDT',
  يواس: 'USDT',
  'يو اس دي تي': 'USDT',
  'يواس دي تي': 'USDT',
  تيثر: 'USDT',
  تتر: 'USDT',
  usd: 'USD',
  دولار: 'USD',
  الدولار: 'USD',
  jod: 'JOD',
  دينار: 'JOD',
  الدينار: 'JOD',
  egp: 'EGP',
  جنيه: 'EGP',
  الجنيه: 'EGP',
};

/** The code of a currency however it was written; null for what is not one of these. */
export const currencyCodeOf = (text: string): string | null =>
  CURRENCY_NAMES[foldName(text)] ?? null;

/** A price that holds however the customer pays: one the manager wrote without saying how. */
export const ANY_CHANNEL = 'ANY';

export interface SheetRate {
  baseCode: string;
  quoteCode: string;
  channel: string;
  /** What the office pays for one of the base currency. */
  buyRate: bigint;
  /** What the office takes for one of the base currency. */
  sellRate: bigint;
}

export interface SheetRemittance {
  destination: string;
  currency: string;
  chargeKind: string;
  chargeValue: bigint;
}

export interface PriceSheet {
  rates: SheetRate[];
  remittances: SheetRemittance[];
  /** Percentages, zero when the office has not set one. */
  usdtForCashDollars: number;
  usdtForBankDollars: number;
  /** Prices the office wrote in for ones the system does not hold. */
  extra?: { item: string; buy: string; sell: string }[];
}

const NAMES: Record<string, string> = {
  USD: 'الدولار',
  ILS: 'الشيكل',
  JOD: 'الدينار',
  EGP: 'الجنيه',
};
const name = (code: string) => NAMES[code] ?? code;

const figure = (value: bigint, places: number) =>
  toDecimalString(value, places).replace(/\.?0+$/, '') || '0';

function rateLine(rate: SheetRate): string | null {
  const sides = [
    rate.buyRate > 0n ? `نشتري بـ ${figure(rate.buyRate, 4)}` : null,
    rate.sellRate > 0n ? `نبيع بـ ${figure(rate.sellRate, 4)}` : null,
  ].filter(Boolean);
  if (sides.length === 0) return null;
  const how =
    rate.channel === ANY_CHANNEL ? '' : rate.channel === 'CASH' ? '، نقداً' : '، بتحويل بنكي';
  return `- ${name(rate.baseCode)} مقابل ${name(rate.quoteCode)}${how}: ${sides.join('، ')} ${name(rate.quoteCode)}`;
}

function remittanceLine(row: SheetRemittance): string {
  const fee =
    row.chargeKind === 'PERCENT'
      ? `${figure(row.chargeValue, 4)}%`
      : `${figure(row.chargeValue, 2)} ${name(row.currency)}`;
  return `- إلى ${row.destination} بعملة ${name(row.currency)}: الرسوم ${fee}`;
}

function extraLine(row: { item: string; buy: string; sell: string }): string {
  const sides = [
    row.buy ? `نشتري بـ ${row.buy}` : null,
    row.sell ? `نبيع بـ ${row.sell}` : null,
  ].filter(Boolean);
  return `- ${row.item}: ${sides.join('، ')}`;
}

export function composePriceSheet(sheet: PriceSheet): string {
  const rates = sheet.rates.map(rateLine).filter((line): line is string => line !== null);
  const usdt = [
    sheet.usdtForCashDollars > 0
      ? `- شراء USDT مقابل دولار نقدي: نخصم ${sheet.usdtForCashDollars}%`
      : null,
    sheet.usdtForBankDollars > 0
      ? `- شراء USDT مقابل دولار بتحويل بنكي: نخصم ${sheet.usdtForBankDollars}%`
      : null,
  ].filter((line): line is string => line !== null);
  return [
    'أسعار الصرف:',
    ...(rates.length > 0 ? rates : ['لا توجد أسعار منشورة الآن.']),
    ...(usdt.length > 0 ? ['', 'USDT مقابل الدولار:', ...usdt] : []),
    '',
    'رسوم الحوالات:',
    ...(sheet.remittances.length > 0
      ? sheet.remittances.map(remittanceLine)
      : ['لا توجد رسوم منشورة، يحددها موظف.']),
    ...(sheet.extra?.length ? ['', 'أسعار أخرى من المكتب:', ...sheet.extra.map(extraLine)] : []),
  ].join('\n');
}
