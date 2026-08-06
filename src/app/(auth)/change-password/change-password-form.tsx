'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, KeyRound, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { PASSWORD_RULES, passwordStrength } from '@/core/security/password-strength';
import { Alert, Button } from '@/ui/primitives';
import { Field, PasswordInput } from '@/ui/form';
import { cn } from '@/ui/utils';

export function ChangePasswordForm() {
  const { t } = useLocale();
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const strength = passwordStrength(newPassword);
  const matches = newPassword.length > 0 && newPassword === confirmPassword;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setBusy(true);

    try {
      const result = await api.post<{ redirect: string }>('/api/me/password', {
        currentPassword,
        newPassword,
        confirmPassword,
      });

      router.push(result.redirect);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setError(t(caught.messageKey as never, caught.params) || caught.message);
      } else {
        setError(t('errors.generic'));
      }
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert tone="danger">{error}</Alert>}

      <Field label={t('auth.currentPassword')} required error={fieldErrors.currentPassword}>
        {(props) => (
          <PasswordInput
            {...props}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            autoFocus
          />
        )}
      </Field>

      <Field label={t('auth.newPassword')} required error={fieldErrors.newPassword}>
        {(props) => (
          <PasswordInput
            {...props}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
          />
        )}
      </Field>

      {newPassword && (
        <div className="space-y-2">
          <div className="flex gap-1" aria-hidden>
            {[0, 1, 2, 3].map((index) => (
              <span
                key={index}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  index < strength
                    ? strength <= 1
                      ? 'bg-danger'
                      : strength === 2
                        ? 'bg-warning'
                        : 'bg-success'
                    : 'bg-border-base',
                )}
              />
            ))}
          </div>

          {/* Show the policy live rather than after a failed submit. */}
          <ul className="space-y-0.5">
            {PASSWORD_RULES.map((rule) => {
              const met = rule.test(newPassword);
              return (
                <li
                  key={rule.key}
                  className={cn(
                    'flex items-center gap-1.5 text-xs',
                    met ? 'text-success-text' : 'text-content-tertiary',
                  )}
                >
                  {met ? <Check className="size-3" /> : <X className="size-3" />}
                  {t(`validation.${rule.key}` as never, { min: 10 })}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Field label={t('auth.confirmPassword')} required error={fieldErrors.confirmPassword}>
        {(props) => (
          <PasswordInput
            {...props}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            autoComplete="new-password"
          />
        )}
      </Field>

      {confirmPassword && !matches && (
        <p className="text-xs text-danger-text">{t('validation.passwordMismatch')}</p>
      )}

      <Button
        type="submit"
        variant="primary"
        fullWidth
        size="lg"
        icon={<KeyRound />}
        loading={busy}
        disabled={!currentPassword || !matches || strength < 2}
      >
        {t('auth.changePassword')}
      </Button>
    </form>
  );
}
