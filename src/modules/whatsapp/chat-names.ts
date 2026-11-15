import 'server-only';
import { prisma } from '@/core/db/prisma';

/**
 * The names conversations are shown under: the customer's own record when the
 * office has one for that number, else the name they go by on WhatsApp.
 *
 * Numbers are matched on their last nine digits, so one saved as 0599… and one
 * arriving as 970599… are the same person.
 */

const keyOf = (phone: string | null | undefined) => {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length >= 9 ? digits.slice(-9) : null;
};

/** Customer record names by number, for the phones given. */
export async function customerNames(
  phones: (string | null | undefined)[],
  locale: 'ar' | 'en' = 'ar',
): Promise<Map<string, string>> {
  const keys = [...new Set(phones.map(keyOf).filter((key): key is string => Boolean(key)))];
  const names = new Map<string, string>();
  if (keys.length === 0) return names;
  const rows = await prisma.customer.findMany({
    where: { OR: keys.map((key) => ({ phone: { endsWith: key } })) },
    select: { phone: true, fullNameAr: true, fullNameEn: true },
    take: 500,
  });
  for (const row of rows) {
    const key = keyOf(row.phone);
    const name = (locale === 'ar' ? row.fullNameAr : row.fullNameEn) || row.fullNameAr;
    if (key && name && !names.has(key)) names.set(key, name);
  }
  return names;
}

/** The name to show: the office's record first, then WhatsApp's. */
export function shownName(
  phone: string | null | undefined,
  whatsappName: string | null | undefined,
  records: Map<string, string>,
): string | null {
  const key = keyOf(phone);
  return (key && records.get(key)) || whatsappName?.trim() || null;
}
