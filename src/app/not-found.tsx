import Link from 'next/link';

/**
 * The 404 page.
 *
 * Rendered under the static root layout, so it has no locale context and must
 * not read cookies, resolve a session or touch the database — doing any of that
 * is what made this route dynamic and pushed 404 generation onto the
 * pages-router error shell, which fails to build.
 *
 * Both languages are shown rather than one. A 404 is frequently reached from a
 * stale link or a typed URL, where there may be no session and therefore no
 * language preference to honour; showing both is more useful than guessing.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-canvas px-4 text-center">
      <p className="font-mono text-5xl font-bold text-content-tertiary">404</p>

      <h1 className="mt-2 text-lg font-semibold text-content">Page not found</h1>
      <p className="text-lg font-semibold text-content" dir="rtl">
        الصفحة غير موجودة
      </p>

      <p className="mt-2 max-w-sm text-sm text-content-secondary">
        The page you are looking for does not exist or has moved.
      </p>
      <p className="max-w-sm text-sm text-content-secondary" dir="rtl">
        الصفحة التي تبحث عنها غير موجودة أو تم نقلها.
      </p>

      <Link
        href="/dashboard"
        className="mt-5 rounded-[var(--radius-control)] bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
      >
        Dashboard · لوحة المعلومات
      </Link>
    </div>
  );
}
