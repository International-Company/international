import { toDecimalString } from '@/core/money/money';

/**
 * The office's prices in words, as the assistant on the private number is given them.
 *
 * Holds what a customer may be told and nothing else. A remittance row has only
 * what the office charges: what the correspondent charges the office never comes
 * in here, so no question can get it out.
 */

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
  extra?: { item: string; price: string }[];
}

const NAMES: Record<string, string> = { USD: 'الدولار', ILS: 'الشيكل', JOD: 'الدينار', EGP: 'الجنيه' };
const name = (code: string) => NAMES[code] ?? code;

const figure = (value: bigint, places: number) =>
  toDecimalString(value, places).replace(/\.?0+$/, '') || '0';

function rateLine(rate: SheetRate): string | null {
  const sides = [
    rate.buyRate > 0n ? `نشتريه من العميل بـ ${figure(rate.buyRate, 4)}` : null,
    rate.sellRate > 0n ? `نبيعه للعميل بـ ${figure(rate.sellRate, 4)}` : null,
  ].filter(Boolean);
  if (sides.length === 0) return null;
  const how = rate.channel === 'CASH' ? 'نقداً' : 'بتحويل بنكي';
  return `- ${name(rate.baseCode)} مقابل ${name(rate.quoteCode)}، ${how}: ${sides.join('، ')} ${name(rate.quoteCode)}`;
}

function remittanceLine(row: SheetRemittance): string {
  const fee =
    row.chargeKind === 'PERCENT'
      ? `${figure(row.chargeValue, 4)}%`
      : `${figure(row.chargeValue, 2)} ${name(row.currency)}`;
  return `- إلى ${row.destination} بعملة ${name(row.currency)}: الرسوم ${fee}`;
}

export function composePriceSheet(sheet: PriceSheet): string {
  const rates = sheet.rates.map(rateLine).filter((line): line is string => line !== null);
  const usdt = [
    sheet.usdtForCashDollars > 0
      ? `- يبيعنا العميل USDT ويأخذ دولاراً نقدياً: نخصم ${sheet.usdtForCashDollars}%`
      : null,
    sheet.usdtForBankDollars > 0
      ? `- يبيعنا العميل USDT ويأخذ دولاراً بتحويل بنكي: نخصم ${sheet.usdtForBankDollars}%`
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
    ...(sheet.extra?.length
      ? ['', 'أسعار أخرى من المكتب:', ...sheet.extra.map((row) => `- ${row.item}: ${row.price}`)]
      : []),
  ].join('\n');
}
