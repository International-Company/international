import Link from 'next/link';
import { getTranslator } from '@/i18n/server';

export default async function NotFound() {
  const { t } = await getTranslator();

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
