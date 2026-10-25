'use client';

import { useState } from 'react';
import { useLocale } from '@/i18n/provider';
import { Button } from '@/ui/primitives';

/**
 * Counting a stack note by note.
 *
 * A teller counting a drawer counts piles — seven two-hundreds, twelve
 * hundreds — and adds them in his head, which is where counts go wrong. This
 * takes the piles and does the sum, and anything that is not a note (coins, a
 * torn note set aside) goes in one free figure at the end.
 */

/** The notes in circulation, largest first. Anything else is entered as change. */
const NOTES: Record<string, number[]> = {
  ILS: [200, 100, 50, 20, 10, 5, 2, 1],
  USD: [100, 50, 20, 10, 5, 2, 1],
  JOD: [50, 20, 10, 5, 1],
};

export function hasNotes(currency: string): boolean {
  return (NOTES[currency]?.length ?? 0) > 0;
}

export function DenominationCounter({
  currency,
  decimals,
  onUse,
}: {
  currency: string;
  decimals: number;
  /** Hands the total back, as a plain amount the field can hold. */
  onUse: (amount: string) => void;
}) {
  const { t } = useLocale();
  const notes = NOTES[currency] ?? [];
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [change, setChange] = useState('');

  // In hundredths throughout, so a count of notes plus change adds exactly.
  const scale = 10 ** Math.min(decimals, 3);
  const noteTotal = notes.reduce(
    (sum, note) => sum + note * scale * (Number.parseInt(counts[note] ?? '', 10) || 0),
    0,
  );
  const changeTotal = Math.round((Number.parseFloat(change) || 0) * scale);
  const total = noteTotal + changeTotal;
  const text = (total / scale).toFixed(Math.min(decimals, 3)).replace(/\.0+$/, '');

  return (
    <div className="space-y-2 rounded-xl bg-surface-sunken p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {notes.map((note) => (
          <label key={note} className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1.5">
            <span className="w-10 text-end text-sm font-semibold tabular-nums ltr-content">
              {note}
            </span>
            <span className="text-xs text-content-tertiary">×</span>
            <input
              type="text"
              inputMode="numeric"
              dir="ltr"
              value={counts[note] ?? ''}
              placeholder="0"
              onChange={(event) =>
                setCounts((current) => ({
                  ...current,
                  [note]: event.target.value.replace(/[^\d]/g, ''),
                }))
              }
              className="w-full min-w-0 bg-transparent text-end text-sm tabular-nums outline-none"
            />
          </label>
        ))}
        <label className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1.5">
          <span className="text-xs text-content-tertiary">{t('handover.coins')}</span>
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            value={change}
            placeholder="0"
            onChange={(event) => setChange(event.target.value.replace(/[^\d.]/g, ''))}
            className="w-full min-w-0 bg-transparent text-end text-sm tabular-nums outline-none"
          />
        </label>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={total <= 0} onClick={() => onUse(text)}>
          {t('handover.useTotal', { amount: `${text} ${currency}` })}
        </Button>
      </div>
    </div>
  );
}
