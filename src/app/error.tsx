'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { Button } from '@/ui/primitives';

/**
 * Route-level error boundary.
 *
 * Shows the message and, in development, the stack. In production the digest is
 * shown instead — enough for an operator to quote to support, without exposing
 * internals to whoever is standing at the counter.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useLocale();

  useEffect(() => {
    console.error('Route error', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-danger-subtle text-danger-text">
        <AlertTriangle className="size-5" />
      </div>

      <h1 className="text-lg font-semibold text-content">{t('errors.title')}</h1>
      <p className="max-w-md text-sm text-content-secondary">{t('errors.generic')}</p>

      {error.digest && (
        <p className="font-mono text-xs text-content-tertiary ltr-content">{error.digest}</p>
      )}

      {process.env.NODE_ENV === 'development' && (
        <pre className="mt-2 max-w-2xl overflow-x-auto rounded bg-surface-sunken p-3 text-start font-mono text-[10px] text-content-secondary ltr-content">
          {error.stack ?? error.message}
        </pre>
      )}

      <Button variant="primary" className="mt-2" onClick={reset}>
        {t('errors.tryAgain')}
      </Button>
    </div>
  );
}
