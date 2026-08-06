/**
 * Locale configuration.
 *
 * Arabic is the primary operational language and the system default; English is
 * a first-class equivalent, not a fallback. Direction is derived from the
 * locale, never set by hand at a call site.
 */

export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ar';
export const LOCALE_COOKIE = 'ifms_locale';

export type Direction = 'rtl' | 'ltr';

export interface LocaleMeta {
  code: Locale;
  dir: Direction;
  /** The language's own name, as speakers write it. */
  nativeName: string;
  englishName: string;
  /** BCP-47 tag for Intl date and number formatting. */
  intlTag: string;
  fontVariable: string;
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  ar: {
    code: 'ar',
    dir: 'rtl',
    nativeName: 'العربية',
    englishName: 'Arabic',
    intlTag: 'ar',
    fontVariable: 'var(--font-arabic)',
  },
  en: {
    code: 'en',
    dir: 'ltr',
    nativeName: 'English',
    englishName: 'English',
    intlTag: 'en-GB',
    fontVariable: 'var(--font-latin)',
  },
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

export function directionFor(locale: Locale): Direction {
  return LOCALE_META[locale].dir;
}

export function isRtl(locale: Locale): boolean {
  return LOCALE_META[locale].dir === 'rtl';
}
