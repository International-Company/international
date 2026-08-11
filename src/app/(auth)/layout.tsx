import { cookies } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale } from '@/i18n/config';
import {
  DENSITY_COOKIE,
  THEME_COOKIE,
  type Density,
  type ThemePreference,
} from '@/ui/theme/provider';
import { Providers } from '../providers';
import { UpdateWatcher } from '../update-watcher';

/**
 * Layout for the sign-in area.
 *
 * Sign-in, two-factor verification and the forced password change all use
 * client components that need locale, theme and toast context. The root layout
 * no longer supplies these — it is static so the App Router can own its 404 —
 * so this segment reads the cookies and provides them.
 *
 * There is no session yet here, so preferences come from the cookie alone.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();

  const locale = resolveLocale(store.get(LOCALE_COOKIE)?.value);
  const theme = (store.get(THEME_COOKIE)?.value ?? 'system') as ThemePreference;
  const density = (store.get(DENSITY_COOKIE)?.value ?? 'comfortable') as Density;

  return (
    <Providers locale={locale} theme={theme} density={density}>
      {children}
      <UpdateWatcher />
    </Providers>
  );
}
