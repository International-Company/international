import { redirect } from 'next/navigation';
import { getSession } from '@/modules/auth/context';
import { unreadCount } from '@/modules/notifications/notifications.service';
import { AppShell } from '../_shell/app-shell';
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

  const unread = await unreadCount(session.user.id);

  return (
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
      unreadCount={unread}
    >
      {children}
    </AppShell>
  );
}
