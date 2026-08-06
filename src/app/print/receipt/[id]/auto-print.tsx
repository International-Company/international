'use client';

import { useEffect } from 'react';

/**
 * Opens the print dialog once the receipt has rendered.
 *
 * The delay lets webfonts finish loading — printing before the Arabic font
 * arrives produces a receipt in a fallback face with the wrong metrics.
 */
export function AutoPrint() {
  useEffect(() => {
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, []);

  return null;
}
