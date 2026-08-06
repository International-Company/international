import { DEFAULT_LOCALE, LOCALE_COOKIE } from '@/i18n/config';
import { DENSITY_COOKIE, THEME_COOKIE } from '@/ui/theme/provider';

/**
 * Applies language, direction, theme and density before the first paint.
 *
 * The root layout is static — it cannot read cookies without making every route
 * in the application dynamic — so this runs in the browser instead, ahead of
 * hydration. It reads the same cookies the server would have, which means an
 * Arabic operator never sees the interface assemble left-to-right and flip, and
 * a dark-themed workstation never flashes white.
 *
 * Written as a raw string on purpose: it must execute synchronously in <head>,
 * before any markup renders, which no React component can do.
 */
export function PreferenceScript() {
  const script = `
(function () {
  try {
    var root = document.documentElement;

    function cookie(name) {
      var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return match ? decodeURIComponent(match[1]) : null;
    }

    // --- Language and direction ---------------------------------------
    var locale = cookie(${JSON.stringify(LOCALE_COOKIE)});
    if (locale !== 'ar' && locale !== 'en') locale = ${JSON.stringify(DEFAULT_LOCALE)};
    root.lang = locale;
    root.dir = locale === 'ar' ? 'rtl' : 'ltr';
    root.dataset.locale = locale;

    // --- Theme ----------------------------------------------------------
    var theme = cookie(${JSON.stringify(THEME_COOKIE)}) || 'system';
    var dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';

    // --- Density ---------------------------------------------------------
    var density = cookie(${JSON.stringify(DENSITY_COOKIE)});
    root.dataset.density = density === 'compact' ? 'compact' : 'comfortable';
  } catch (e) {
    // A failure here must never block rendering — the defaults already applied
    // on the server are a usable interface.
  }
})();`.trim();

  return <script dangerouslySetInnerHTML={{ __html: script }} suppressHydrationWarning />;
}
