import { redirect } from 'next/navigation';
import { landingFor } from '@/app/_shell/navigation';
import type { Metadata } from 'next';
import { getSession } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import * as settings from '@/modules/settings/settings.service';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect(landingFor(session.user.permissions));

  const { t, locale } = await getTranslator();

  const companyName = await settings
    .getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en')
    .catch(() => t('app.name'));

  return (
    <div className="flex min-h-screen">
      {/* Brand panel — hidden on small screens where it would only cost space. */}
      <div className="relative hidden flex-1 flex-col justify-between bg-primary p-10 text-white lg:flex">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded bg-white/15 text-lg font-bold">
            I
          </div>
          <p className="text-sm font-semibold">{t('app.name')}</p>
        </div>

        <div className="max-w-md">
          <h2 className="text-2xl font-semibold leading-snug">{t('app.fullName')}</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/80">
            {locale === 'ar'
              ? 'منصة متكاملة لإدارة عمليات الصرافة والخزينة، مع سجل تدقيق غير قابل للتعديل ومراقبة فورية للمحافظ الرقمية.'
              : 'An integrated platform for exchange and treasury operations, with an immutable audit trail and live monitoring of digital wallets.'}
          </p>
        </div>

        <p className="text-xs text-white/50">{companyName}</p>
      </div>

      {/* Sign-in panel */}
      <div className="flex flex-1 items-center justify-center bg-canvas px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex size-9 items-center justify-center rounded bg-primary text-lg font-bold text-white">
              I
            </div>
            <p className="text-sm font-semibold text-content">{t('app.name')}</p>
          </div>

          <h1 className="text-xl font-semibold text-content">{t('auth.signInTitle')}</h1>
          <p className="mt-1 text-sm text-content-secondary">{t('auth.signInSubtitle')}</p>

          <div className="mt-6">
            <LoginForm />
          </div>
        </div>
      </div>
    </div>
  );
}
