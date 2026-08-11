'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Fingerprint, LogIn } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Button } from '@/ui/primitives';
import { Field, Input, PasswordInput } from '@/ui/form';

interface LoginResponse {
  status: 'SUCCESS' | 'TWO_FACTOR_REQUIRED' | 'PASSWORD_EXPIRED';
  redirect: string;
}

/**
 * Set on this device when a passkey is enrolled from it.
 *
 * It is a hint for the wording of a message and nothing else — every real check
 * happens on the server. What it buys is the difference between the two things
 * the browser reports identically: a person who dismissed the prompt, and a
 * device that has no key to offer. Telling the first "enrol first" is noise;
 * telling the second nothing at all is a button that appears broken.
 */
export const ENROLLED_MARKER = 'international.passkey.enrolled';

type Translate = ReturnType<typeof useLocale>['t'];

/**
 * What the browser actually objected to.
 *
 * The WebAuthn library wraps the browser's exception in one of its own and
 * hangs the original off `cause`, so testing the thrown value for a
 * `DOMException` finds nothing and every distinct failure collapses into the
 * same unhelpful sentence. Unwrapping is the difference between "it did not
 * work" and "you have not enabled this on this device yet".
 */
export function browserErrorName(caught: unknown): string | null {
  if (caught instanceof DOMException) return caught.name;

  const cause = (caught as { cause?: unknown } | null)?.cause;
  if (cause instanceof DOMException) return cause.name;

  return null;
}

function describeBiometricFailure(caught: unknown, t: Translate): string {
  if (caught instanceof ApiError) {
    return (
      t(caught.messageKey as never, caught.params) || caught.message || t('errors.generic')
    );
  }

  const name = browserErrorName(caught);

  // The browser refuses to sign for a domain that is not its own. Nothing the
  // operator can do about it, so it says who can.
  if (name === 'SecurityError') return t('auth.biometricDomain');

  if (name === 'NotAllowedError' || name === 'AbortError') {
    const enrolled =
      typeof window !== 'undefined' && window.localStorage.getItem(ENROLLED_MARKER) === '1';
    // Enrolled here already: they changed their mind, and the password field is
    // right in front of them. Say nothing.
    return enrolled ? '' : t('auth.biometricNotEnrolled');
  }

  return t('auth.biometricFailed');
}

export function LoginForm() {
  const { t } = useLocale();
  const router = useRouter();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Whether this device can do it at all.
   *
   * Asked of the browser rather than assumed: a desktop with no sensor, an
   * older phone, or an insecure origin all answer no, and offering a button
   * that opens nothing is worse than not offering one.
   */
  /*
   * Three states, not two. `null` means "not asked yet", and it is what lets
   * the space be held open instead of the card growing once the answer comes
   * back — which is the same jump, just later.
   */
  const [biometricReady, setBiometricReady] = useState<boolean | null>(null);
  const [biometricBusy, setBiometricBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        /*
         * Asked of the browser directly rather than through the WebAuthn
         * library. The library's helper is the same one call, but reaching it
         * means fetching its chunk first — and that delay is visible: the
         * button arrives late and the whole centred card grows under the
         * operator's eyes. The library is still what performs the sign-in, and
         * by then a moment's wait costs nothing.
         */
        const available =
          typeof window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable ===
          'function'
            ? await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
            : false;
        if (!cancelled) setBiometricReady(available);
      } catch {
        if (!cancelled) setBiometricReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Anything that has to stop when the person does something else.
   *
   * The waiting request is a live `navigator.credentials.get()`, and only one
   * may be outstanding at a time — so pressing the button, or leaving, has to
   * call it off first or the browser refuses the second.
   */
  const waiting = useRef<AbortController | null>(null);

  const completeSignIn = useCallback(
    async (challengeId: string, response: unknown) => {
      const result = await api.post<LoginResponse>('/api/auth/passkey', {
        step: 'verify',
        challengeId,
        response,
      });

      router.push(result.redirect);
      router.refresh();
    },
    [router],
  );

  /**
   * The phone offering the fingerprint by itself.
   *
   * A modal prompt cannot be opened without the person having touched
   * something — browsers refuse, and they are right to: a page that could raise
   * a fingerprint prompt on load could raise one on any page. What is allowed,
   * and what this is, is a *conditional* request: it waits, silently, and the
   * passkey appears inside the sign-in field's own suggestions. Touching the
   * field offers it; one tap reads the finger and the person is in, without
   * ever meeting a button.
   *
   * It stays pending until it is used or the page goes away, so a person who
   * would rather type a password is not interrupted by it.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (typeof window.PublicKeyCredential?.isConditionalMediationAvailable !== 'function') {
          return;
        }
        if (!(await window.PublicKeyCredential.isConditionalMediationAvailable())) return;
        if (cancelled) return;

        const { startAuthentication } = await import('@simplewebauthn/browser');

        const { challengeId, options } = await api.post<{ challengeId: string; options: never }>(
          '/api/auth/passkey',
          { step: 'options' },
        );
        if (cancelled) return;

        const controller = new AbortController();
        waiting.current = controller;

        const response = await startAuthentication({
          optionsJSON: options,
          useBrowserAutofill: true,
        });
        if (cancelled) return;

        await completeSignIn(challengeId, response);
      } catch {
        /*
         * Silent by design. This one was never asked for: it is an offer the
         * browser makes on its own, and an offer nobody took up is not a
         * failure to report. Anything the person actually pressed reports
         * through `signInWithBiometrics`.
         */
      }
    })();

    return () => {
      cancelled = true;
      waiting.current?.abort();
      waiting.current = null;
    };
  }, [completeSignIn]);

  const signInWithBiometrics = useCallback(async () => {
    setError(null);
    setBiometricBusy(true);

    // The silent request holds the only slot the browser allows.
    waiting.current?.abort();
    waiting.current = null;

    try {
      const { startAuthentication } = await import('@simplewebauthn/browser');

      const { challengeId, options } = await api.post<{ challengeId: string; options: never }>(
        '/api/auth/passkey',
        { step: 'options' },
      );

      const response = await startAuthentication({ optionsJSON: options });

      await completeSignIn(challengeId, response);
    } catch (caught) {
      setError(describeBiometricFailure(caught, t));
      setBiometricBusy(false);
    }
  }, [completeSignIn, t]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await api.post<LoginResponse>('/api/auth/login', { identifier, password });

      // `refresh()` discards the cached signed-out tree so the shell renders
      // with the new session instead of a stale one.
      router.push(result.redirect);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(
          t(caught.messageKey as never, caught.params) ||
            caught.message ||
            t('errors.generic'),
        );
      } else {
        setError(t('errors.generic'));
      }
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {error && (
        <Alert tone="danger" icon={<AlertTriangle />}>
          {error}
        </Alert>
      )}

      <Field label={t('auth.username')} required>
        {(props) => (
          <Input
            {...props}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            /*
             * `webauthn` is what lets the passkey appear among this field's own
             * suggestions. Without it the conditional request above waits for a
             * hint the browser never gives, and the fingerprint is only ever
             * reachable through the button.
             */
            autoComplete="username webauthn"
            autoFocus
            dir="ltr"
            required
          />
        )}
      </Field>

      <Field label={t('auth.password')} required>
        {(props) => (
          <PasswordInput
            {...props}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        )}
      </Field>

      <Button
        type="submit"
        variant="primary"
        fullWidth
        size="lg"
        loading={submitting}
        icon={<LogIn />}
      >
        {submitting ? t('auth.signingIn') : t('auth.signIn')}
      </Button>

      {/*
        Offered under the password rather than above it. A device with no
        passkey enrolled yet would find the top of the form occupied by a button
        that cannot help it — and the password is still the way in that always
        works.

        The space is held from the first paint while the answer is still
        unknown, so the button appears *into* it rather than pushing the card
        open underneath it. A form that grows a moment after it is drawn is a
        form somebody is already typing into.
      */}
      {biometricReady !== false && (
        <div className="space-y-4" style={{ minHeight: '5.75rem' }}>
          {biometricReady && (
            <>
              <div className="flex items-center gap-3 pt-1" aria-hidden>
                <span className="h-px flex-1 bg-border-base" />
                <span className="text-xs text-content-tertiary">{t('common.or')}</span>
                <span className="h-px flex-1 bg-border-base" />
              </div>

              <Button
                type="button"
                variant="secondary"
                fullWidth
                size="lg"
                loading={biometricBusy}
                icon={<Fingerprint />}
                onClick={() => void signInWithBiometrics()}
              >
                {t('auth.signInWithBiometrics')}
              </Button>
            </>
          )}
        </div>
      )}

      <p className="pt-2 text-center text-xs text-content-tertiary">
        {t('auth.forgotPasswordHint')}
      </p>
    </form>
  );
}
