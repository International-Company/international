'use client';

import { useEffect } from 'react';

/** Long enough to be seen as an opening rather than a flicker; no longer than the page takes. */
const AT_LEAST_MS = 900;

/**
 * Takes the opening screen away once the page is up: after the first screen
 * has painted, and not before it has been on long enough to read as meant.
 */
export function AppSplashDone() {
  useEffect(() => {
    const splash = document.getElementById('app-splash');
    if (!splash || getComputedStyle(splash).display === 'none') {
      return;
    }
    const shown = performance.now();
    const wait = Math.max(0, AT_LEAST_MS - shown);
    let gone: ReturnType<typeof setTimeout> | undefined;
    const leave = setTimeout(() => {
      splash.classList.add('as-leaving');
      // Hidden, not removed: the node is React's, and taking it out from under it breaks the next render.
      gone = setTimeout(() => splash.classList.add('as-gone'), 500);
    }, wait);
    return () => {
      clearTimeout(leave);
      if (gone) clearTimeout(gone);
    };
  }, []);

  return null;
}
