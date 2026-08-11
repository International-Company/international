import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { DEFAULT_LOCALE, LOCALE_META } from '@/i18n/config';
import { PreferenceScript } from './preference-script';
import { ServiceWorker } from './service-worker';
import { BRAND } from './_shell/brand';
import './globals.css';

/**
 * Root layout — the document shell, and nothing else.
 *
 * It deliberately performs **no I/O**: no cookies, no session, no database.
 * Anything dynamic here makes every route in the application dynamic, including
 * `/_not-found`, which forces Next to generate the 404 from the pages-router
 * error shell instead of the App Router's own. Keeping this layout static lets
 * the App Router own its 404.
 *
 * Language and theme are therefore applied by `PreferenceScript`, which runs
 * before first paint and reads the same cookies the server would have. The
 * server-rendered attributes below are only the defaults it corrects.
 * Authenticated pages still resolve the locale on the server — see
 * `(app)/layout.tsx`, which is dynamic and passes it into the providers.
 */

/*
 * The fonts are in the repository, not fetched from Google at build time.
 *
 * `next/font/google` downloads them while compiling, which makes every
 * deployment depend on a third party being reachable from the build machine —
 * and one afternoon it was not, so a build that had nothing to do with fonts
 * failed and the office could not deploy. A financial system should not stop
 * shipping because a font server had a bad day.
 *
 * The files are the same faces, taken from their npm packages, trimmed to the
 * weights and subsets actually used: Latin for Inter, Arabic and Latin for
 * Plex. 368 kB in the repository buys a build that needs nothing but itself.
 */
const latin = localFont({
  src: [
    { path: './fonts/inter-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/inter-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/inter-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/inter-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-latin',
  display: 'swap',
  // Named so the fallback metrics match, which is what keeps text from
  // shifting as the real face arrives.
  fallback: ['system-ui', 'Segoe UI', 'Arial', 'sans-serif'],
});

const arabic = localFont({
  src: [
    { path: './fonts/plex-arabic-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/plex-latin-400.woff2', weight: '400', style: 'normal' },
    { path: './fonts/plex-arabic-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/plex-latin-500.woff2', weight: '500', style: 'normal' },
    { path: './fonts/plex-arabic-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/plex-latin-600.woff2', weight: '600', style: 'normal' },
    { path: './fonts/plex-arabic-700.woff2', weight: '700', style: 'normal' },
    { path: './fonts/plex-latin-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-arabic',
  display: 'swap',
  fallback: ['Segoe UI', 'Tahoma', 'system-ui', 'sans-serif'],
});

export const metadata: Metadata = {
  title: {
    default: 'International — Financial Management System',
    template: '%s · International',
  },
  description: 'Enterprise exchange and treasury operations platform',
  robots: { index: false, follow: false },
  manifest: '/manifest.webmanifest',
  /*
   * Every path carries a hash of the logo file, so replacing the logo replaces
   * the URL — and no browser tab, no launcher and no home screen can go on
   * showing the previous one.
   */
  icons: {
    icon: [
      { url: BRAND.favicon32, sizes: '32x32', type: 'image/png' },
      { url: BRAND.favicon64, sizes: '64x64', type: 'image/png' },
    ],
    // iOS ignores the manifest entirely and reads this link instead.
    apple: BRAND.appleTouchIcon,
  },
  /*
   * Installed on a phone, this is a standalone application rather than a page
   * in a browser: no address bar, and its own entry in the task switcher. The
   * title is what shows under the icon, so it is the short Arabic name and not
   * the long bilingual one above.
   */
  appleWebApp: {
    capable: true,
    title: 'انترنشونال',
    statusBarStyle: 'default',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /*
   * Zoom is left enabled. An installed counter tool is used by people reading
   * amounts, and locking the scale to save a pinch is the kind of tidiness that
   * costs somebody their ability to read the figure they are about to pay out.
   */
  maximumScale: 5,
  // Draws under the notch and the home indicator; the shell already pads for
  // the safe area, so the alternative is a letterboxed strip on every iPhone.
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111827' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang={DEFAULT_LOCALE}
      dir={LOCALE_META[DEFAULT_LOCALE].dir}
      // The preference script rewrites lang/dir/class/data-density before
      // hydration, so React must not object to the attributes changing.
      suppressHydrationWarning
    >
      <head>
        <PreferenceScript />
      </head>
      <body className={`${latin.variable} ${arabic.variable} antialiased`}>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
