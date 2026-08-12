import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getSession } from '@/modules/auth/context';
import { resolveLocale, LOCALE_COOKIE } from '@/i18n/config';
import {
  DENSITY_COOKIE,
  THEME_COOKIE,
  type Density,
  type ThemePreference,
} from '@/ui/theme/provider';
import { AppShell } from '../_shell/app-shell';
import { Providers } from '../providers';
import { bootstrap } from '@/core/bootstrap';

/**
 * Authenticated layout.
 *
 * Every route beneath this segment is gated here. Three redirects come before
 * the shell renders, in order of severity: no session, an unsatisfied second
 * factor, and a password that must be changed. Enforcing them at the layout
 * means no page can be reached by typing its URL directly.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Idempotent — see the note in `src/core/http/route.ts`. Page renders and API
  // requests are the two ways into this process, and both bootstrap it.
  bootstrap();

  const session = await getSession();
  if (!session) redirect('/login');

  if (session.user.twoFactorEnabled && !session.twoFactorSatisfied) {
    redirect('/login/two-factor');
  }
  if (session.user.mustChangePassword) {
    redirect('/change-password');
  }

  // Preferences come from the profile first, then the cookie. This layout is
  // already dynamic, so resolving them here costs nothing and means the first
  // server render is in the right language and theme.
  const store = await cookies();
  const locale = resolveLocale(session.user.locale || store.get(LOCALE_COOKIE)?.value);
  const theme = (session.user.theme ||
    store.get(THEME_COOKIE)?.value ||
    'system') as ThemePreference;
  const density = (session.user.density ||
    store.get(DENSITY_COOKIE)?.value ||
    'comfortable') as Density;

  return (
    <Providers locale={locale} theme={theme} density={density}>
      <AppShell
        user={{
          id: session.user.id,
          fullNameEn: session.user.fullNameEn,
          fullNameAr: session.user.fullNameAr,
          jobTitleEn: session.user.jobTitleEn,
          jobTitleAr: session.user.jobTitleAr,
          username: session.user.username,
          branchNameEn: session.user.branchNameEn,
          branchNameAr: session.user.branchNameAr,
          permissions: session.user.permissions,
          roles: session.user.roles,
        }}
      >
        {children}
      </AppShell>
    </Providers>
  );
}
