import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { getSession } from '@/modules/auth/context';
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_META, resolveLocale, type Direction, type Locale } from './config';
import { createTranslator, getDictionary, pickLocalized, type TranslateFn } from './translate';

/**
 * Server-side locale resolution.
 *
 * Order of precedence: the signed-in user's saved preference, then the cookie
 * set by the language switcher, then the default. Reading the profile first
 * means the language follows the operator to any workstation they sign in at.
 */

export const getLocale = cache(async (): Promise<Locale> => {
  const session = await getSession();
  if (session?.user.locale) return resolveLocale(session.user.locale);

  const store = await cookies();
  return resolveLocale(store.get(LOCALE_COOKIE)?.value);
});

export const getDirection = cache(async (): Promise<Direction> => {
  return LOCALE_META[await getLocale()].dir;
});

/**
 * The server-side translator. Use in server components and API responses so
 * a message rendered on the server matches the client exactly.
 */
export const getTranslator = cache(
  async (): Promise<{
    t: TranslateFn;
    locale: Locale;
    dir: Direction;
    isRtl: boolean;
    ln: (record: object, baseKey: string) => string;
  }> => {
    const locale = await getLocale();
    return {
      t: createTranslator(locale),
      locale,
      dir: LOCALE_META[locale].dir,
      isRtl: LOCALE_META[locale].dir === 'rtl',
      ln: (record, baseKey) => pickLocalized(record, baseKey, locale),
    };
  },
);

export { getDictionary, DEFAULT_LOCALE };
