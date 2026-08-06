import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
import { cookies } from 'next/headers';
import { LOCALE_COOKIE, LOCALE_META, resolveLocale } from '@/i18n/config';
import { LocaleProvider } from '@/i18n/provider';
import {
  DENSITY_COOKIE,
  THEME_COOKIE,
  ThemeProvider,
  ThemeScript,
  type Density,
  type ThemePreference,
} from '@/ui/theme/provider';
import { ToastProvider } from '@/ui/overlay';
import './globals.css';

/**
 * Root layout.
 *
 * `lang` and `dir` are resolved on the server from the locale cookie, so the
 * very first paint is already in the correct direction — an Arabic operator
 * never sees the interface assemble left-to-right and then flip.
 */

const latin = Inter({
  subsets: ['latin'],
  variable: '--font-latin',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  variable: '--font-arabic',
  display: 'swap',
  weight: ['400', '500', '600', '700'],
});

export const metadata: Metadata = {
  title: {
    default: 'IFMS — International Financial Management System',
    template: '%s · IFMS',
  },
  description: 'Enterprise exchange and treasury operations platform',
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
};

/**
 * Nothing in this application may be prerendered at build time.
 *
 * Every page is specific to the signed-in operator, their permissions, their
 * branch and their language — there is no page whose HTML is the same for two
 * users, so a build-time snapshot is never correct. The layout already reads
 * cookies, which makes routes dynamic as a side effect; stating it explicitly
 * makes that a guarantee rather than an accident, and stops the builder from
 * attempting to prerender shells like `/404` in an environment that has no
 * request, no session and no reachable database.
 */
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f8fa' },
    { media: '(prefers-color-scheme: dark)', color: '#111827' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();

  const locale = resolveLocale(store.get(LOCALE_COOKIE)?.value);
  const theme = (store.get(THEME_COOKIE)?.value ?? 'system') as ThemePreference;
  const density = (store.get(DENSITY_COOKIE)?.value ?? 'comfortable') as Density;

  return (
    <html
      lang={locale}
      dir={LOCALE_META[locale].dir}
      data-locale={locale}
      data-density={density}
      suppressHydrationWarning
    >
      <head>
        <ThemeScript theme={theme} density={density} />
      </head>
      <body className={`${latin.variable} ${arabic.variable} antialiased`}>
        <ThemeProvider initialTheme={theme} initialDensity={density}>
          <LocaleProvider initialLocale={locale}>
            <ToastProvider>{children}</ToastProvider>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
