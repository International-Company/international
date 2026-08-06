'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, LogIn } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Button } from '@/ui/primitives';
import { Field, Input, PasswordInput } from '@/ui/form';

interface LoginResponse {
  status: 'SUCCESS' | 'TWO_FACTOR_REQUIRED' | 'PASSWORD_EXPIRED';
  redirect: string;
}

export function LoginForm() {
  const { t } = useLocale();
  const router = useRouter();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
            autoComplete="username"
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

      <p className="pt-2 text-center text-xs text-content-tertiary">
        {t('auth.forgotPasswordHint')}
      </p>
    </form>
  );
}
