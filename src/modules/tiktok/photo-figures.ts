import { normalizeDigits } from '@/core/money/money';

/**
 * A sum read off a withdrawal's photo, as the amount fields take it: plain
 * digits and a point, or null when it is not a sum greater than zero.
 *
 * The reading comes from outside the program, so it is held to this before it
 * reaches a field. A blank field the teller fills is better than a wrong figure.
 */
export function photoFigure(value: string | null | undefined): string | null {
  if (!value) return null;
  const plain = normalizeDigits(value)
    .trim()
    .replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(plain)) return null;
  return Number(plain) > 0 ? plain : null;
}
