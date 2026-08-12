'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
 *
 * ## Where it appears
 *
 * The watching is one thing and the showing is another, so they are separated
 * here: `useUpdateWatcher` does the asking, and two very small components do
 * the showing, because the two places it can appear are not alike.
 *
 * Inside the application it is a chip **in the header**, in the flow of the
 * layout rather than floating over it. A card pinned to the bottom of the
 * viewport was painted across the navigation — it had to be, since it was
 * centred on the whole window and drawn above everything — and a notice that
 * covers the buttons somebody is reaching for has chosen the wrong moment to be
 * helpful. In the header it cannot cover anything at any width, by construction
 * rather than by arithmetic, and it sits where the rest of the system's state
 * already lives.
 *
 * On the sign-in screen there is no header, and nothing behind it to cover, so
 * there it stays a card.
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

/**
 * Asks whether the server is serving something newer, and applies it.
 *
 * A hook rather than a component so the answer can be shown in more than one
 * shape without the asking being written twice.
 */
export function useUpdateWatcher() {
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

  return { available, apply };
}

/**
 * The header form: a chip beside the other header controls.
 *
 * Nothing at all until there is something to say, so it costs no space on the
 * days there is no new build — and when it does appear it is the only coloured
 * thing in a row of grey icons, which is enough to be noticed without being in
 * the way. The words are dropped on a narrow screen where the header is
 * already tight; the icon and the colour carry it, and the label stays for
 * anyone reading it aloud.
 */
export function UpdateChip() {
  const { t } = useLocale();
  const { available, apply } = useUpdateWatcher();

  if (!available) return null;

  return (
    <button
      type="button"
      onClick={apply}
      title={t('common.updateReady')}
      aria-label={`${t('common.updateReady')} — ${t('common.updateNow')}`}
      className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-2.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover sm:px-3"
    >
      <RefreshCw className="size-3.5 shrink-0" aria-hidden />
      <span className="hidden whitespace-nowrap sm:inline">{t('common.updateNow')}</span>
    </button>
  );
}

/**
 * The standalone form, for the sign-in screen, which has no header to sit in.
 */
export function UpdateWatcher() {
  const { t } = useLocale();
  const { available, apply } = useUpdateWatcher();

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
