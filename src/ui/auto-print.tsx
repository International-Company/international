'use client';

import { useState } from 'react';
import { useLocale } from '@/i18n/provider';

/**
 * The receipt, printed the moment a deal is recorded.
 *
 * Printed from a frame kept off the screen rather than a new window: a browser
 * blocks a window opened after waiting on the server, and the teller would have
 * to close it anyway. The frame loads the same receipt page, which prints itself
 * once its fonts and logo have arrived.
 *
 * Whether the print dialog appears is the browser's decision, not this page's.
 * Chrome started with --kiosk-printing sends it straight to the default printer.
 *
 * A choice per device, not per office: a counter's computer has the printer, and
 * a manager's phone does not.
 */

const KEY = 'ifms.autoPrintReceipt';
/** Long enough for a print dialog left open while a teller answers a customer. */
const FRAME_LIFETIME_MS = 5 * 60_000;

export function autoPrintEnabled(): boolean {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored !== null) return stored === '1';
  } catch {
    // Blocked storage falls through to the default.
  }
  return !window.matchMedia('(pointer: coarse)').matches;
}

/** Prints a deal's receipt, when this device prints and this person may. */
export function printAfterRecording(transactionId: string, permissions: string[]): void {
  if (!permissions.includes('exchange.receipt.print') || !autoPrintEnabled()) return;

  const frame = document.createElement('iframe');
  frame.title = 'receipt';
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // Off the screen with a real size: some browsers will not print a frame with none.
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0';
  frame.src = `/print/receipt/${transactionId}`;

  const remove = () => frame.remove();
  const timer = setTimeout(remove, FRAME_LIFETIME_MS);
  frame.addEventListener('load', () => {
    frame.contentWindow?.addEventListener('afterprint', () => {
      clearTimeout(timer);
      // Not at once: some browsers are still reading the frame as this fires.
      setTimeout(remove, 2000);
    });
  });
  document.body.appendChild(frame);
}

/** The switch for it, beside the receipt it just printed. */
export function AutoPrintToggle() {
  const { t } = useLocale();
  const [enabled, setEnabled] = useState(autoPrintEnabled);

  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-content-secondary">
      <input
        type="checkbox"
        className="size-4 accent-[var(--primary)]"
        checked={enabled}
        onChange={(event) => {
          setEnabled(event.target.checked);
          try {
            window.localStorage.setItem(KEY, event.target.checked ? '1' : '0');
          } catch {
            // Without storage the choice lasts as long as this screen.
          }
        }}
      />
      {t('receipt.autoPrint')}
    </label>
  );
}
