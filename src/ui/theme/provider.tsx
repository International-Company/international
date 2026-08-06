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

/**
 * Theme and density.
 *
 * `system` follows the operating system live — if the OS switches to dark at
 * sunset, so does the interface, without a reload. An explicit light or dark
 * choice always wins over the OS.
 *
 * The resolved class is applied to <html> in a layout effect and mirrored to a
 * cookie, so the inline boot script (see `ThemeScript`) can set the correct
 * class before first paint. Without that, every page load would flash white.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type Density = 'comfortable' | 'compact';

export const THEME_COOKIE = 'ifms_theme';
export const DENSITY_COOKIE = 'ifms_density';

interface ThemeContextValue {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemePreference) => void;
  toggleTheme: () => void;
  density: Density;
  setDensity: (density: Density) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function writeCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function ThemeProvider({
  children,
  initialTheme = 'system',
  initialDensity = 'comfortable',
}: {
  children: ReactNode;
  initialTheme?: ThemePreference;
  initialDensity?: Density;
}) {
  const [theme, setThemeState] = useState<ThemePreference>(initialTheme);
  const [density, setDensityState] = useState<Density>(initialDensity);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(
    initialTheme === 'system' ? 'light' : initialTheme,
  );

  // Resolve `system` against the OS, and keep following it while selected.
  useEffect(() => {
    if (theme !== 'system') {
      setResolvedTheme(theme);
      return;
    }

    setResolvedTheme(systemTheme());

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent) => {
      setResolvedTheme(event.matches ? 'dark' : 'light');
    };

    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', resolvedTheme === 'dark');
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  const persist = useCallback((patch: { theme?: ThemePreference; density?: Density }) => {
    void fetch('/api/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).catch(() => undefined);
  }, []);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setThemeState(next);
      writeCookie(THEME_COOKIE, next);
      persist({ theme: next });
    },
    [persist],
  );

  const setDensity = useCallback(
    (next: Density) => {
      setDensityState(next);
      writeCookie(DENSITY_COOKIE, next);
      persist({ density: next });
    },
    [persist],
  );

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  }, [resolvedTheme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme, density, setDensity }),
    [theme, resolvedTheme, setTheme, toggleTheme, density, setDensity],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}

/**
 * Runs before React hydrates and before the first paint. It reads the stored
 * preference and stamps the class on <html> synchronously, which is the only
 * way to avoid a white flash on a dark-themed workstation.
 */
export function ThemeScript({
  theme = 'system',
  density = 'comfortable',
}: {
  theme?: ThemePreference;
  density?: Density;
}) {
  const script = `
(function(){
  try {
    var pref = ${JSON.stringify(theme)};
    var dark = pref === 'dark' ||
      (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
    root.dataset.density = ${JSON.stringify(density)};
  } catch (e) {}
})();`.trim();

  return <script dangerouslySetInnerHTML={{ __html: script }} suppressHydrationWarning />;
}
