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
 * ## One family for both scripts
 *
 * This replaced a pair — Inter for Latin, IBM Plex Sans Arabic for Arabic —
 * drawn by different hands to different metrics. In an Arabic interface the two
 * meet inside almost every line, because the digits are Latin and the words are
 * not, and two families meeting mid-sentence never quite agree on the height of
 * a figure beside a letter.
 *
 * Alexandria is one superfamily whose Arabic and Latin were designed together,
 * so a rate and the word in front of it sit on the same line by construction
 * rather than by adjustment.
 *
 * ## Chosen by measurement, not by taste
 *
 * Every candidate was loaded in a browser and asked one question: does
 * `1111111111` occupy the same width as `0000000000` under `tabular-nums`? A
 * face that answers no cannot hold a money column still — the figures shuffle
 * sideways as the digits change, which is the one thing a ledger may not do.
 *
 * Three well-regarded Arabic faces failed it, including the one first chosen
 * here for its looks. Alexandria passed, and so is what a column of shekels is
 * set in.
 *
 * ## Variable, which is why this is smaller and not larger
 *
 * Two axis files carry every weight — for both scripts together, against the
 * twelve static cuts they replace — and semi-bold is now an actual weight
 * rather than the nearest one that happened to be bundled.
 */
const sans = localFont({
  src: [
    { path: './fonts/alexandria-latin.woff2', weight: '100 900', style: 'normal' },
    { path: './fonts/alexandria-arabic.woff2', weight: '100 900', style: 'normal' },
  ],
  variable: '--font-sans-face',
  display: 'swap',
  // Named so the fallback metrics match, which is what keeps text from
  // shifting as the real face arrives.
  fallback: ['Segoe UI', 'Tahoma', 'system-ui', 'sans-serif'],
});

/*
 * A real monospace, at last.
 *
 * Sixty-three places set `font-mono` — every transaction reference, every shift
 * and approval number, the countdown on a granted price — and until now the
 * stack behind it named no file at all. A reference read aloud between a
 * manager on Windows and a teller on Android was rendered by two different
 * typefaces, and the one string in this system that exists to be quoted
 * verbatim looked different at each end of the sentence.
 */
const mono = localFont({
  src: [{ path: './fonts/geist-mono.woff2', weight: '100 900', style: 'normal' }],
  variable: '--font-mono-face',
  display: 'swap',
  fallback: ['ui-monospace', 'Cascadia Mono', 'Menlo', 'monospace'],
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
      <body className={`${sans.variable} ${mono.variable} antialiased`}>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
