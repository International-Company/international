'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Monitor } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { passwordStrength } from '@/core/security/password-strength';
import { Alert, Badge, Button, Card, CardBody, CardHeader } from '@/ui/primitives';
import { Field, PasswordInput } from '@/ui/form';
import { useToast } from '@/ui/overlay';
import { DateText } from '@/ui/display';
import { cn } from '@/ui/utils';

interface SessionRow {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  isActive: boolean;
}

export function ProfileSecurity({
  sessions,
  currentSessionId,
}: {
  sessions: SessionRow[];
  currentSessionId: string;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const strength = passwordStrength(newPassword);

  const change = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setBusy(true);

    try {
      await api.post('/api/me/password', { currentPassword, newPassword, confirmPassword });
      toast.success(t('auth.passwordChanged'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setFieldErrors(caught.fieldErrors());
        setError(say(t, caught.messageKey, caught.params) || caught.message);
      } else {
        setError(t('errors.generic'));
      }
    } finally {
      setBusy(false);
    }
  };

  const active = sessions.filter((session) => session.isActive);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* --- Password ----------------------------------------------------- */}
      <Card>
        <CardHeader title={t('auth.changePassword')} />
        <CardBody>
          <form onSubmit={change} className="space-y-4" noValidate>
            {error && <Alert tone="danger">{error}</Alert>}

            <Field label={t('auth.currentPassword')} required error={fieldErrors.currentPassword}>
              {(props) => (
                <PasswordInput
                  {...props}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
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
              <div>
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
                <p className="mt-1 text-xs text-content-secondary">
                  {t('auth.passwordStrength')}:{' '}
                  {t(`auth.strength.${strength}` as never)}
                </p>
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

            <Button
              type="submit"
              variant="primary"
              icon={<KeyRound />}
              loading={busy}
              disabled={!currentPassword || !newPassword || newPassword !== confirmPassword}
            >
              {t('auth.changePassword')}
            </Button>
          </form>
        </CardBody>
      </Card>

      {/* --- Sessions ------------------------------------------------------ */}
      <Card>
        <CardHeader
          title={t('auth.activeSessions')}
          description={`${active.length}`}
        />
        <ul className="divide-y divide-border-base">
          {sessions.slice(0, 10).map((session) => (
            <li key={session.id} className="flex items-start gap-3 px-4 py-3">
              <Monitor className="mt-0.5 size-4 shrink-0 text-content-tertiary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-content">
                  {session.userAgent?.slice(0, 60) ?? t('common.unknown')}
                </p>
                <p className="text-xs text-content-tertiary ltr-content">
                  {session.ip ?? '—'} · <DateText value={session.lastSeenAt} relative />
                </p>
              </div>
              {session.id === currentSessionId ? (
                <Badge tone="primary">{t('auth.thisDevice')}</Badge>
              ) : session.isActive ? (
                <Badge tone="success">{t('common.active')}</Badge>
              ) : (
                <Badge tone="neutral">{t('common.inactive')}</Badge>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
