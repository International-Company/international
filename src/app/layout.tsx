import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, Inter } from 'next/font/google';
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
