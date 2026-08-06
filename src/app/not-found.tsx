'use client';

import Link from 'next/link';
import { useLocale } from '@/i18n/provider';

/**
 * The 404 page.
 *
 * Deliberately a client component. Next prerenders this route at build time,
 * where there is no request and no reachable database — so resolving the
 * session here (to read the user's saved language) fails the build, and Next
 * reports it as the misleading "`<Html>` should not be imported" error from its
 * fallback error shell.
 *
 * It renders inside the root layout, so `LocaleProvider` already has the locale
 * that was resolved from the cookie on the server. Translation works exactly as
 * everywhere else, with no I/O of its own.
 */
export default function NotFound() {
  const { t } = useLocale();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas px-4 text-center">
      <p className="font-mono text-5xl font-bold text-content-tertiary">404</p>
      <h1 className="text-lg font-semibold text-content">{t('errors.pageNotFound')}</h1>
      <p className="max-w-sm text-sm text-content-secondary">{t('errors.pageNotFoundBody')}</p>
      <Link
        href="/dashboard"
        className="mt-2 rounded-[var(--radius-control)] bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
      >
        {t('errors.goHome')}
      </Link>
    </div>
  );
}
