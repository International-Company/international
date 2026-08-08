import { redirect } from 'next/navigation';
import { landingFor } from '@/app/_shell/navigation';
import type { Metadata } from 'next';
import { getSession } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import { TwoFactorForm } from './two-factor-form';

export const metadata: Metadata = { title: 'Two-factor verification' };

export default async function TwoFactorPage() {
  const session = await getSession();

  if (!session) redirect('/login');
  // Already verified — nothing to do here.
  if (session.twoFactorSatisfied) redirect(landingFor(session.user.permissions));

  const { t } = await getTranslator();

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-content">{t('auth.twoFactorTitle')}</h1>
        <p className="mt-1 text-sm text-content-secondary">{t('auth.twoFactorSubtitle')}</p>

        <div className="mt-6">
          <TwoFactorForm />
        </div>
      </div>
    </div>
  );
}
