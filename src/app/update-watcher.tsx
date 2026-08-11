'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale } from '@/i18n/provider';

/**
 * Notices when a newer version has been deployed, and takes it.
 *
 * An installed application is not a browser tab. It sits open on a phone for
 * days, and left alone it would keep running whatever build it happened to
 * launch with — so it asks, every minute and every time it comes back to the
 * foreground, whether the server is serving something newer than itself.
 *
 * **It will not reload over typed work.** A teller mid-way through an amount,
 * an address or a customer's name would lose it, and a system that throws away
 * what someone has typed in order to install an improvement has not improved
 * anything. So when the page holds anything typed, the update waits behind a
 * button and the person decides when.
 *
 * There is no version negotiation and no partial update. What arrives is
 * whatever the server is serving, because the pages and the code are fetched
 * from the network every time — see `public/sw.js` for why nothing here is
 * cached in the first place.
 *
 * **It reloads at most once for any given build.** The first version of this
 * did not, and the consequence was the worst failure it could have: the two
 * sides disagreed about which build was live for a reason reloading could not
 * fix, so it reloaded, and reloaded, and the application shook itself apart in
 * front of whoever was using it. The cause is fixed — see `/api/version` — but
 * a mechanism that can reload the page must not be able to spin no matter what
 * it is told, so the guard stays. After one attempt the update waits behind the
 * button like any other.
 *
 * Mounted inside the two authenticated-area layouts rather than the root, which
 * is static and carries no locale — and a banner that can only speak one
 * language is a string hard-coded in a system that has none.
 */

const POLL_MS = 60_000;

/**
 * Baked in at build time by `generateBuildId`, which writes the same value into
 * `.next/BUILD_ID` — the file the server reads back. Equal by construction for
 * any one build, which is what makes a difference between them mean something.
 */
const MY_BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? '';

/** Which build this tab has already reloaded itself in the hope of reaching. */
const ATTEMPTED_KEY = 'international.update.attempted';

export function UpdateWatcher() {
  const { t } = useLocale();
  const [available, setAvailable] = useState(false);
  const reloading = useRef(false);

  /** Whether anything on the page looks like work in progress. */
  const hasTypedWork = useCallback(() => {
    const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input, textarea',
    );
    for (const field of fields) {
      if (field.type === 'hidden' || field.disabled || field.readOnly) continue;
      if (field.value.trim() !== '') return true;
    }
    // A dialog open is a decision half-made, even with nothing typed into it.
    return document.querySelector('[role="dialog"]') !== null;
  }, []);

  const apply = useCallback(() => {
    if (reloading.current) return;
    reloading.current = true;

    /*
     * Drop the cached build output on the way out. Its URLs carry content
     * hashes so the old entries would never be served again — they would simply
     * accumulate, one build at a time, on a phone nobody ever clears.
     */
    navigator.serviceWorker?.controller?.postMessage({ type: 'CLEAR_STATIC' });

    // `replace` rather than `reload`: a reload would re-submit whatever POST
    // put the operator on this page.
    window.location.replace(window.location.href);
  }, []);

  useEffect(() => {
    // Nothing to compare against when running from `next dev`, where the build
    // has no id at all.
    if (!MY_BUILD) return;

    let cancelled = false;

    const check = async () => {
      if (cancelled || reloading.current || document.visibilityState !== 'visible') return;
      try {
        const response = await fetch('/api/version', { cache: 'no-store' });
        if (!response.ok) return;

        const { build } = (await response.json()) as { build?: string | null };

        // No id at all means the server cannot tell us — not that it is newer.
        if (!build || build === MY_BUILD) return;

        /*
         * Already reloaded once reaching for this exact build and still here.
         * Reloading again would not land anywhere different, so it stops and
         * offers the button instead. This is the guard that turns a possible
         * loop into at most one wasted reload.
         */
        if (window.sessionStorage.getItem(ATTEMPTED_KEY) === build) {
          setAvailable(true);
          return;
        }

        if (hasTypedWork()) {
          setAvailable(true);
          return;
        }

        window.sessionStorage.setItem(ATTEMPTED_KEY, build);
        apply();
      } catch {
        // Offline, or the server is restarting mid-deploy. Either way the next
        // tick asks again; a failed check is not news worth showing anyone.
      }
    };

    const timer = setInterval(check, POLL_MS);
    // The moment they come back to the app, which is when a new build is most
    // likely to have landed while it sat in the background.
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    void check();

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, [apply, hasTypedWork]);

  if (!available) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
    >
      <div className="flex w-full max-w-md items-center gap-3 rounded-2xl bg-surface px-4 py-3 shadow-[var(--shadow-lg)] ring-1 ring-border-base">
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
        <span className="min-w-0 flex-1 text-sm text-content">{t('common.updateReady')}</span>
        <button
          type="button"
          onClick={apply}
          className="shrink-0 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover"
        >
          {t('common.updateNow')}
        </button>
      </div>
    </div>
  );
}
