import { formatMoney, MONEY_FACTOR, toDecimalString } from '@/core/money/money';
import { LOCALE_META, type Locale } from './config';

/**
 * Locale-aware formatting.
 *
 * Latin digits are used in both languages. Arabic-Indic numerals are correct
 * typographically, but exchange staff reconcile against bank statements,
 * blockchain explorers and printed receipts that all use Latin digits — mixing
 * systems is how a 7 gets read as a V. Everything else (month names, weekdays,
 * ordering) follows the locale.
 */

const DIGIT_OVERRIDE = '-u-nu-latn';

function tagFor(locale: Locale): string {
  return `${LOCALE_META[locale].intlTag}${DIGIT_OVERRIDE}`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function formatDate(
  value: Date | string | number,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = toDate(value);
  if (!date) return '—';

  return new Intl.DateTimeFormat(tagFor(locale), {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    ...options,
  }).format(date);
}

export function formatDateTime(value: Date | string | number, locale: Locale): string {
  const date = toDate(value);
  if (!date) return '—';

  return new Intl.DateTimeFormat(tagFor(locale), {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatTime(value: Date | string | number, locale: Locale): string {
  const date = toDate(value);
  if (!date) return '—';

  return new Intl.DateTimeFormat(tagFor(locale), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

/** ISO date for inputs and export filenames — never locale-dependent. */
export function toISODate(value: Date | string | number): string {
  const date = toDate(value);
  if (!date) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatRelative(value: Date | string | number, locale: Locale): string {
  const date = toDate(value);
  if (!date) return '—';

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);

  // Beyond a week a calendar date is more useful than "12 days ago".
  if (absolute > 604_800) return formatDate(date, locale);

  const formatter = new Intl.RelativeTimeFormat(tagFor(locale), { numeric: 'auto' });

  if (absolute < 60) return formatter.format(seconds, 'second');
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86_400), 'day');
}

function toDate(value: Date | string | number): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// ---------------------------------------------------------------------------
// Numbers & money
// ---------------------------------------------------------------------------

export function formatNumber(
  value: number,
  locale: Locale,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(tagFor(locale), options).format(value);
}

export function formatPercent(value: number, locale: Locale, fractionDigits = 1): string {
  return new Intl.NumberFormat(tagFor(locale), {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export interface AmountOptions {
  currency?: string;
  decimals?: number;
  signDisplay?: 'auto' | 'always' | 'never';
}

/** Formats a scaled bigint amount. Accepts the string form used over the wire. */
export function formatAmount(
  value: bigint | string,
  locale: Locale,
  options: AmountOptions = {},
): string {
  const amount = typeof value === 'bigint' ? value : BigInt(value || '0');
  return formatMoney(amount, {
    decimals: options.decimals ?? 2,
    locale: LOCALE_META[locale].intlTag,
    currency: options.currency,
    signDisplay: options.signDisplay,
  });
}

/** Rates need more precision than amounts; four places is the market norm. */
export function formatRate(value: bigint | string, decimals = 4): string {
  const rate = typeof value === 'bigint' ? value : BigInt(value || '0');
  return toDecimalString(rate, decimals);
}

/** Compact form for dashboard tiles: 1.2M, 850K. */
export function formatCompactAmount(value: bigint | string, locale: Locale): string {
  const amount = typeof value === 'bigint' ? value : BigInt(value || '0');
  const units = Number(amount / MONEY_FACTOR);

  return new Intl.NumberFormat(tagFor(locale), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(units);
}

export function formatBytes(bytes: number | bigint, locale: Locale): string {
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${formatNumber(size, locale, { maximumFractionDigits: 1 })} ${units[unitIndex]}`;
}

export function formatDuration(ms: number, locale: Locale): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${formatNumber(seconds, locale, { maximumFractionDigits: 1 })} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
