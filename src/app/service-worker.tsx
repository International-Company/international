'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker, which is what makes the system installable.
 *
 * A component rather than an inline script because the root layout must stay
 * static — it performs no I/O and renders no dynamic markup — and a client
 * component satisfies that while still running in the browser.
 *
 * `updateViaCache: 'none'` so the worker file itself is always revalidated.
 * Without it the browser may serve a cached worker for up to a day, which is
 * how a fix to the caching rules ends up not arriving for a day.
 *
 * Nothing here forces an update. The new worker waits for the tabs to close;
 * see `public/sw.js` for why taking over mid-shift would be worse than waiting.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    // After load, so registration never competes with the first paint on the
    // slow connection where that actually matters.
    const register = () => {
      void navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(() => {
          // An unregistered worker costs the install prompt and nothing else.
          // The application is fully functional without it, so a failure here
          // is not worth interrupting anyone over.
        });
    };

    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });

    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
