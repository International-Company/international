import { cookies } from 'next/headers';
import { z } from 'zod';
import { route } from '@/core/http/route';
import { login } from '@/modules/auth/auth.service';
import { SESSION_COOKIE } from '@/modules/auth/session.service';
import { isProduction } from '@/core/config/env';

const bodySchema = z.object({
  identifier: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
  totp: z.string().max(10).optional(),
});

export const POST = route<z.infer<typeof bodySchema>>({
  public: true,
  bodySchema,
  // The service applies per-account limits too; this caps a single origin.
  rateLimit: { key: 'login', limit: 20, windowSeconds: 300 },
  handler: async ({ body, meta }) => {
    const result = await login(body, { ip: meta.ip, userAgent: meta.userAgent });

    const store = await cookies();
    store.set(SESSION_COOKIE, result.session.token, {
      httpOnly: true,
      // Session tokens must never be reachable from JavaScript, and must not
      // ride along on cross-site requests.
      sameSite: 'lax',
      secure: isProduction,
      path: '/',
      expires: result.session.absoluteExpiresAt,
    });

    if (result.status === 'TWO_FACTOR_REQUIRED') {
      return { status: 'TWO_FACTOR_REQUIRED' as const, redirect: '/login/two-factor' };
    }
    if (result.status === 'PASSWORD_EXPIRED') {
      return { status: 'PASSWORD_EXPIRED' as const, redirect: '/change-password' };
    }

    return { status: 'SUCCESS' as const, redirect: '/', locale: result.locale };
  },
});
