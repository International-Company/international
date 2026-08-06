'use client';

import type { ReactNode } from 'react';
import { LocaleProvider } from '@/i18n/provider';
import { ThemeProvider, type Density, type ThemePreference } from '@/ui/theme/provider';
import { ToastProvider } from '@/ui/overlay';
import type { Locale } from '@/i18n/config';

/**
 * Client context for the authenticated and authentication areas.
 *
 * These live below the root layout rather than inside it on purpose. Reading
 * cookies in the root layout makes *every* route dynamic — including
 * `/_not-found` — which forces Next to fall back to the pages-router error
 * shell to produce a static 404, and that shell fails to build. Keeping the
 * root layout free of dynamic APIs lets the App Router own its own 404.
 *
 * The layouts that render this are dynamic anyway (they resolve the session),
 * so they pass the server-resolved preferences straight through and the first
 * paint is already correct.
 */
export function Providers({
  children,
  locale,
  theme,
  density,
}: {
  children: ReactNode;
  locale: Locale;
  theme: ThemePreference;
  density: Density;
}) {
  return (
    <ThemeProvider initialTheme={theme} initialDensity={density}>
      <LocaleProvider initialLocale={locale}>
        <ToastProvider>{children}</ToastProvider>
      </LocaleProvider>
    </ThemeProvider>
  );
}
