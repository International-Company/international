'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * Route-level error boundary.
 *
 * Self-contained by necessity: it can be triggered by a failure in a segment
 * that never finished rendering its providers, so it must not depend on locale
 * or theme context. Both languages are shown for the same reason.
 *
 * In development the stack is shown. In production only the digest is — enough
 * for an operator to quote to support, without exposing internals to whoever
 * happens to be standing at the counter.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Route error', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 px-4 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-danger-subtle text-danger-text">
        <AlertTriangle className="size-5" />
      </div>

      <h1 className="mt-2 text-lg font-semibold text-content">Something went wrong</h1>
      <p className="text-lg font-semibold text-content" dir="rtl">
        حدث خطأ ما
      </p>

      <p className="mt-1 max-w-md text-sm text-content-secondary">
        An unexpected error occurred. Please try again.
      </p>
      <p className="max-w-md text-sm text-content-secondary" dir="rtl">
        حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.
      </p>

      {error.digest && (
        <p className="mt-2 font-mono text-xs text-content-tertiary ltr-content">{error.digest}</p>
      )}

      {process.env.NODE_ENV === 'development' && (
        <pre className="mt-2 max-w-2xl overflow-x-auto rounded bg-surface-sunken p-3 text-start font-mono text-[10px] text-content-secondary ltr-content">
          {error.stack ?? error.message}
        </pre>
      )}

      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-[var(--radius-control)] bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
      >
        Try again · إعادة المحاولة
      </button>
    </div>
  );
}
