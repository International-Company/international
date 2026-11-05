'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { normalizeDigits } from '@/core/money/money';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { useToast } from '@/ui/overlay';

/**
 * Remittances sent before the correspondent's price was known, each with a place
 * to write it. A teller gets their own; someone who sees every deal gets them all.
 */

interface Row {
  id: string;
  reference: string;
  currency: string;
  amountText: string;
  who: string | null;
  createdAt: string;
}

export function UnpricedRemittances({ refresh }: { refresh: string | null }) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<Row[]>('/api/exchange/remittance/unpriced'));
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refresh]);

  const save = async (id: string) => {
    setSaving(id);
    try {
      await api.post(`/api/exchange/remittance/${id}/price`, { cost: typed[id] ?? '' });
      toast.success(t('remittance.priceAdded'));
      void load();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      );
    } finally {
      setSaving(null);
    }
  };

  if (rows.length === 0) return null;

  return (
    <section className="mx-auto w-full max-w-xl rounded-2xl bg-surface ring-1 ring-warning/40">
      <h3 className="px-4 pt-3 text-sm font-semibold text-content">
        {t('remittance.unpriced')} ({rows.length})
      </h3>
      <ul className="divide-y divide-border-subtle">
        {rows.map((row) => {
          const value = typed[row.id] ?? '';
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 basis-40">
                <p className="ltr-content text-start text-base font-bold tabular-nums text-content">
                  {row.amountText} {row.currency}
                </p>
                <p className="truncate text-xs text-content-secondary">
                  {[
                    row.who,
                    new Date(row.createdAt).toLocaleString(locale, {
                      dateStyle: 'short',
                      timeStyle: 'short',
                    }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className="font-mono text-[11px] text-content-tertiary ltr-content text-start">
                  {row.reference}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  dir="ltr"
                  inputMode="decimal"
                  autoComplete="off"
                  aria-label={`${t('remittance.correspondentCharges')} ${row.reference}`}
                  placeholder={t('remittance.correspondentCharges')}
                  value={value}
                  onChange={(event) =>
                    setTyped((all) => ({
                      ...all,
                      [row.id]: normalizeDigits(event.target.value)
                        .replace(/[,٫٬]/g, '.')
                        .replace(/[^\d.]/g, '')
                        .replace(/(\..*)\./g, '$1'),
                    }))
                  }
                  className="h-11 w-32 rounded-xl bg-surface-sunken px-3 text-end text-base font-semibold tabular-nums text-content outline-none ring-1 ring-border-subtle focus:ring-primary"
                />
                <button
                  type="button"
                  disabled={!(Number(value) > 0) || saving === row.id}
                  onClick={() => void save(row.id)}
                  className="flex h-11 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
                >
                  {saving === row.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    t('common.save')
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
