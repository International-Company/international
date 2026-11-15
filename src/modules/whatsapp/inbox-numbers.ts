import { normalizeDigits } from '@/core/money/money';

/**
 * The full numbers a phone typed at the counter could be, most likely first.
 *
 * Written with its country code (+ or 00) it is that number. Written the local
 * way, 05… or 5…, it may be a Palestinian (970) or an Israeli (972) line, and
 * only WhatsApp knows which: both are offered, and the first it knows is used.
 */
export function candidateNumbers(typed: string): string[] {
  const raw = normalizeDigits(typed).trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return [];
  if (raw.startsWith('+')) return digits.length >= 8 ? [digits] : [];
  if (digits.startsWith('00')) return digits.length >= 10 ? [digits.slice(2)] : [];
  const local = digits.startsWith('0') ? digits.slice(1) : digits;
  if (local.length === 9 && local.startsWith('5')) return [`970${local}`, `972${local}`];
  return digits.length >= 10 && !digits.startsWith('0') ? [digits] : [];
}
