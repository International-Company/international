'use client';

import { useEffect } from 'react';

/**
 * Last-resort error boundary.
 *
 * This one replaces the root layout entirely, so it must render its own
 * `<html>` and `<body>` and cannot rely on any provider — no locale context, no
 * theme context, no design-system components that read CSS variables the layout
 * would normally have supplied. Everything here is self-contained and inlined.
 *
 * Without it the App Router falls back to the pages-router error shell, which
 * is where the opaque "`<Html>` should not be imported outside of
 * pages/_document" build failure comes from.
 *
 * Both languages are shown side by side: the mechanism that decides which one
 * to use is part of what has failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global error', error);
  }, [error]);

  return (
    <html lang="en" dir="ltr">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#f7f8fa',
          color: '#111827',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
          padding: '1rem',
        }}
      >
        <div style={{ maxWidth: '30rem', textAlign: 'center' }}>
          <p style={{ fontSize: '2.5rem', fontWeight: 700, color: '#b91c1c', margin: 0 }}>!</p>

          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, marginTop: '0.75rem' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '1.125rem', fontWeight: 600, margin: '0.25rem 0 0' }} dir="rtl">
            حدث خطأ ما
          </p>

          <p style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.75rem' }}>
            The application could not start. Please try again, and contact your system
            administrator if this continues.
          </p>
          <p style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.5rem' }} dir="rtl">
            تعذّر تشغيل التطبيق. يرجى المحاولة مرة أخرى، وإبلاغ مدير النظام إذا استمرت المشكلة.
          </p>

          {error.digest && (
            <p
              style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: '0.75rem',
                color: '#9ca3af',
                marginTop: '1rem',
              }}
            >
              {error.digest}
            </p>
          )}

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '1.25rem',
              padding: '0.5rem 1.25rem',
              borderRadius: '0.375rem',
              border: 'none',
              backgroundColor: '#1d4ed8',
              color: '#ffffff',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Try again · إعادة المحاولة
          </button>
        </div>
      </body>
    </html>
  );
}
