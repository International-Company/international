import type { Dictionary, TranslationKey, TranslationParams } from './types';
import en from './locales/en';
import ar from './locales/ar';
import { DEFAULT_LOCALE, type Locale } from './config';

/**
 * The translation engine. Isomorphic — the same function backs the server
 * renderer and the client hook, so a string can never differ between the two.
 */

export const DICTIONARIES: Record<Locale, Dictionary> = {
  en: en as unknown as Dictionary,
  ar,
};

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}

function lookup(dictionary: unknown, path: string): unknown {
  let current: unknown = dictionary;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Substitutes `{name}` placeholders. Unmatched placeholders are left intact so
 * a missing parameter is visible during review rather than silently blank.
 */
export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

/**
 * Resolves a key against a dictionary.
 *
 * Falls back to English, then to the key itself. Returning the key rather than
 * an empty string means an untranslated label is obvious in the interface
 * instead of leaving a mysteriously blank button.
 */
export function translate(
  dictionary: Dictionary,
  key: TranslationKey | (string & {}),
  params?: TranslationParams,
): string {
  const value = lookup(dictionary, key);
  if (typeof value === 'string') return interpolate(value, params);

  const fallback = lookup(DICTIONARIES[DEFAULT_LOCALE === 'ar' ? 'en' : 'ar'], key);
  if (typeof fallback === 'string') return interpolate(fallback, params);

  const english = lookup(DICTIONARIES.en, key);
  if (typeof english === 'string') return interpolate(english, params);

  return key;
}

export type TranslateFn = (
  key: TranslationKey | (string & {}),
  params?: TranslationParams,
) => string;

export function createTranslator(locale: Locale): TranslateFn {
  const dictionary = getDictionary(locale);
  return (key, params) => translate(dictionary, key, params);
}

// ---------------------------------------------------------------------------
// Bilingual record helper
// ---------------------------------------------------------------------------

/**
 * Many records carry both scripts (`fullNameEn` / `fullNameAr`). This picks the
 * right one for the active locale and falls back when a field is empty, so a
 * record entered in only one language still displays something useful.
 */
export function pickLocalized(record: object, baseKey: string, locale: Locale): string {
  // Accepts any object shape — interfaces have no index signature, and every
  // call site passes a concrete row type rather than a bag of unknowns.
  const source = record as Record<string, unknown>;

  const preferred = locale === 'ar' ? `${baseKey}Ar` : `${baseKey}En`;
  const alternate = locale === 'ar' ? `${baseKey}En` : `${baseKey}Ar`;

  const value = source[preferred];
  if (typeof value === 'string' && value.trim()) return value;

  const other = source[alternate];
  if (typeof other === 'string' && other.trim()) return other;

  return '';
}

/** Same idea for a plain `{ en, ar }` pair. */
export function pickPair(pair: { en: string; ar: string }, locale: Locale): string {
  return locale === 'ar' ? pair.ar || pair.en : pair.en || pair.ar;
}
