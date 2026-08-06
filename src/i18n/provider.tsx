'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_META,
  resolveLocale,
  type Direction,
  type Locale,
} from './config';
import { createTranslator, pickLocalized, type TranslateFn } from './translate';
import type { TranslationKey, TranslationParams } from './types';

/**
 * Locale context.
 *
 * Switching language re-renders the tree and rewrites `dir`/`lang` on <html>
 * in the same commit — no page reload, no flash of the previous direction. The
 * choice is persisted to a cookie so the server renders the correct direction
 * on the very first paint of the next visit, and to the user's profile so it
 * follows them to another workstation.
 */

interface LocaleContextValue {
  locale: Locale;
  dir: Direction;
  isRtl: boolean;
  t: TranslateFn;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  /** Picks `xxxAr` or `xxxEn` from a record for the active locale. */
  ln: (record: object, baseKey: string) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(resolveLocale(initialLocale));

  const meta = LOCALE_META[locale];

  // Keep the document in step with the active locale. Direction lives on the
  // root element so every descendant — including portalled dialogs — inherits it.
  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dir = meta.dir;
    root.dataset.locale = locale;
  }, [locale, meta.dir]);

  const persist = useCallback((next: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;

    // Best-effort profile sync. A failure here is not worth interrupting the
    // user for — the cookie already made the change stick on this device.
    void fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locale: next }),
    }).catch(() => undefined);
  }, []);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      persist(next);
    },
    [persist],
  );

  const toggleLocale = useCallback(() => {
    setLocale(locale === 'ar' ? 'en' : 'ar');
  }, [locale, setLocale]);

  const value = useMemo<LocaleContextValue>(() => {
    const translate = createTranslator(locale);
    return {
      locale,
      dir: meta.dir,
      isRtl: meta.dir === 'rtl',
      t: translate,
      setLocale,
      toggleLocale,
      ln: (record, baseKey) => pickLocalized(record, baseKey, locale),
    };
  }, [locale, meta.dir, setLocale, toggleLocale]);

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (!context) {
    throw new Error('useLocale must be used inside <LocaleProvider>');
  }
  return context;
}

/** Convenience hook for components that only need the translate function. */
export function useTranslation(): {
  t: TranslateFn;
  locale: Locale;
  dir: Direction;
  isRtl: boolean;
} {
  const { t, locale, dir, isRtl } = useLocale();
  return { t, locale, dir, isRtl };
}

export type { TranslationKey, TranslationParams };
