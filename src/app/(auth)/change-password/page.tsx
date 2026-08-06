import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { Alert } from '@/ui/primitives';
import { ChangePasswordForm } from './change-password-form';

export const metadata: Metadata = { title: 'Change password' };

/**
 * The forced password change. Reached when an account is new, has been reset,
 * or its password has expired. Deliberately outside the application shell:
 * there is exactly one thing to do here.
 */
export default async function ChangePasswordPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const { t } = await getTranslator();

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-content">{t('auth.changePassword')}</h1>
        <p className="mt-1 text-sm text-content-secondary">
          {session.user.mustChangePassword
            ? t('auth.changePasswordRequired')
            : t('auth.passwordExpired')}
        </p>

        <div className="mt-6 space-y-4">
          <Alert tone="warning">{t('auth.changePasswordRequired')}</Alert>
          <ChangePasswordForm />
        </div>
      </div>
    </div>
  );
}
