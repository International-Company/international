'use client';

import { useEffect } from 'react';

/**
 * Opens the print dialog once the receipt has rendered.
 *
 * It waits for the webfonts and for every image on the page — printing before
 * the Arabic font arrives produces a receipt in a fallback face with the wrong
 * metrics, and printing before the logo arrives produces one without it. A
 * short floor and a ceiling keep it from either racing or hanging.
 */
export function AutoPrint() {
  useEffect(() => {
    let cancelled = false;

    const images = Array.from(document.images).map((image) =>
      image.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            image.addEventListener('load', () => resolve(), { once: true });
            image.addEventListener('error', () => resolve(), { once: true });
          }),
    );
    const ready = Promise.all([document.fonts.ready, ...images]);
    const ceiling = new Promise((resolve) => setTimeout(resolve, 3000));
    const floor = new Promise((resolve) => setTimeout(resolve, 400));

    void Promise.all([Promise.race([ready, ceiling]), floor]).then(() => {
      if (!cancelled) window.print();
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
