import { cookies } from 'next/headers';
import { route } from '@/core/http/route';
import { logout } from '@/modules/auth/auth.service';
import { SESSION_COOKIE } from '@/modules/auth/session.service';

export const POST = route({
  // Allow a half-authenticated session to sign out — being stuck at the
  // two-factor prompt with no way back is a dead end.
  allowPendingTwoFactor: true,
  handler: async ({ session, meta }) => {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;

    if (token) {
      await logout(
        token,
        {
          id: session.user.id,
          name: session.user.fullNameEn,
          sessionId: session.sessionId,
        },
        { ip: meta.ip, userAgent: meta.userAgent },
      );
    }

    store.delete(SESSION_COOKIE);
    return { ok: true };
  },
});
