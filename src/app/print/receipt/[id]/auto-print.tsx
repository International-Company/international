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
export function AutoPrint({ rollWidthMm }: { rollWidthMm?: number } = {}) {
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
      if (cancelled) return;
      if (rollWidthMm) fitPageToReceipt(rollWidthMm);
      window.print();
    });

    return () => {
      cancelled = true;
    };
  }, [rollWidthMm]);

  return null;
}

/**
 * Sizes the printed page to the tallest receipt copy on it.
 *
 * A browser cannot print a page of "whatever length the content is", and a
 * thermal driver left to choose feeds a full A4 length of blank roll. So the
 * copies are measured once they have rendered, and the page is declared that
 * tall — the printer then cuts right after the last line of each copy.
 */
function fitPageToReceipt(widthMm: number) {
  const copies = Array.from(document.querySelectorAll<HTMLElement>('[data-receipt]'));
  if (copies.length === 0) return;
  const tallestPx = Math.max(...copies.map((copy) => copy.getBoundingClientRect().height));
  const heightMm = Math.ceil((tallestPx * 25.4) / 96) + 2;

  const style = document.createElement('style');
  style.textContent = `@media print { @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; } }`;
  document.head.appendChild(style);
}
