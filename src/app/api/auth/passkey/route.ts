import { cookies } from 'next/headers';
import { z } from 'zod';
import { route } from '@/core/http/route';
import { SESSION_COOKIE } from '@/modules/auth/session.service';
import { isProduction } from '@/core/config/env';
import * as passkeys from '@/modules/auth/passkey.service';

/**
 * Signing in with a fingerprint — the public half of the exchange.
 *
 * Two steps, because that is what the standard is: the server offers a
 * challenge, the device signs it, the server checks the signature. Both live
 * here because neither is any use without the other.
 *
 * `public: true` for the same reason the login route is: whoever is asking has
 * not signed in yet. What protects it is the challenge — single-use, expiring,
 * and worthless without the private key that never left the device.
 */

const bodySchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('options') }),
  z.object({
    step: z.literal('verify'),
    challengeId: z.string().min(1).max(60),
    // Shape-checked by the verifier rather than here: WebAuthn responses are
    // nested structures whose validity is a cryptographic question, not a
    // schema one, and a second definition of them here would only drift.
    response: z.unknown(),
  }),
]);

export const POST = route<z.infer<typeof bodySchema>>({
  public: true,
  bodySchema,
  rateLimit: { key: 'passkey', limit: 30, windowSeconds: 300 },
  handler: async ({ body, request, meta }) => {
    if (body.step === 'options') {
      return passkeys.authenticationOptions(request);
    }

    const result = await passkeys.verifyAuthentication(
      { challengeId: body.challengeId, response: body.response },
      { ip: meta.ip, userAgent: meta.userAgent, request },
    );

    // The same cookie, with the same flags, as a password sign-in. Two ways in
    // must not produce two kinds of session.
    const store = await cookies();
    store.set(SESSION_COOKIE, result.session.token, {
      httpOnly: true,
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
