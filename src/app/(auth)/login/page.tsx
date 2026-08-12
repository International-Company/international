import { redirect } from 'next/navigation';
import { landingFor } from '@/app/_shell/navigation';
import { BRAND } from '@/app/_shell/brand';
import type { Metadata } from 'next';
import { getSession } from '@/modules/auth/context';
import { getTranslator } from '@/i18n/server';
import * as settings from '@/modules/settings/settings.service';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Signing in — one screen, and the same one on every device.
 *
 * The two-column arrangement this replaced gave half a desktop to a marketing
 * panel that a phone never saw, which meant the screen most people actually
 * used was the one nobody had designed. This is the phone's screen, centred and
 * given more room on a larger display: the emblem, the company's own name, two
 * fields and a way in.
 *
 * The company name is the one the manager set in Settings, not a constant. It
 * is the name over their door, and the sign-in screen is where staff check they
 * are typing their password into the right system.
 */
export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect(landingFor(session.user.permissions));

  const { t, locale } = await getTranslator();

  const companyName = await settings
    .getString(locale === 'ar' ? 'company.name.ar' : 'company.name.en')
    .catch(() => t('app.name'));

  /*
   * `svh`, not `dvh`.
   *
   * `dvh` tracks the viewport as the address bar slides in and out and as the
   * keyboard opens, so a centred card re-centres every time — a shudder that
   * repeats for as long as the person keeps touching the screen. `svh` is the
   * viewport at its smallest and never changes, so the layout holds still and
   * the browser simply scrolls the focused field into view.
   */
  return (
    <main className="flex min-h-[100svh] flex-col bg-canvas">
      <div className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-[22rem]">
          <div className="flex flex-col items-center text-center">
            {/* eslint-disable-next-line @next/next/no-img-element -- a fixed,
                hashed asset above the fold; the image pipeline would only add a
                round trip before the first paint of the first screen. */}
            <img
              src={BRAND.logo}
              alt={companyName || t('app.name')}
              width={112}
              height={112}
              className="size-24 sm:size-28"
              // The one image on the critical path of the first screen anyone
              // ever sees.
              fetchPriority="high"
            />

            <h1 className="mt-5 text-lg font-semibold text-content">
              {companyName || t('app.name')}
            </h1>
            <p className="mt-1 text-sm text-content-secondary">{t('auth.signInSubtitle')}</p>
          </div>

          <div className="mt-8">
            <LoginForm companyName={companyName || t('app.name')} />
          </div>
        </div>
      </div>
    </main>
  );
}
