'use client';

import { useState } from 'react';
import { Camera, Loader2, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { useToast } from '@/ui/overlay';
import { shrinkPhoto } from '@/ui/proof-photo';

/** One optional photo: a button to choose it, then the picture with a way to remove it. */
export function PhotoField({
  label,
  attach,
  value,
  onChange,
}: {
  label: string;
  attach: string;
  value: string | null;
  onChange: (photo: string | null) => void;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [reading, setReading] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    try {
      onChange(await shrinkPhoto(file));
    } catch {
      toast.error(t('errors.title'), t('errors.proofImageInvalid'));
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="flex min-h-[4.75rem] items-center gap-3 rounded-2xl bg-surface p-3 ring-1 ring-border-subtle">
      {value ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`data:image/jpeg;base64,${value}`}
            alt={label}
            className="size-14 shrink-0 rounded-lg object-cover"
          />
          <span className="min-w-0 flex-1 text-sm text-content">{label}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={t('common.delete')}
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content"
          >
            <X className="size-4" />
          </button>
        </>
      ) : (
        <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 text-sm text-content-secondary transition-colors hover:text-primary-text">
          {reading ? (
            <Loader2 className="size-5 shrink-0 animate-spin" />
          ) : (
            <Camera className="size-5 shrink-0" />
          )}
          {attach}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(event) => {
              void pick(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </label>
      )}
    </div>
  );
}
