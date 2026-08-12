'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';

/**
 * What the ticker is actually showing, and a button to ask again.
 *
 * The settings above this panel say what *should* happen — which pairs, how
 * often, whether to ask the live market. This says what *did*: which source
 * answered each pair, how old its figure is, and which pairs nothing could
 * price. A manager changing the list needs to see the consequence of the change
 * without walking to another screen and squinting at a moving strip.
 */

interface Pair {
  pair: string;
  rate: string;
  cadence: 'DAILY' | 'LIVE';
  source: string;
  asOf: string;
}

const show = (scaled: string): string => {
  const value = Number(BigInt(scaled)) / 1e8;
  if (value >= 1000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (value >= 100) return value.toFixed(2);
  return value.toFixed(4);
};

function age(iso: string, t: (key: never, params?: Record<string, string | number>) => string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return t('market.justNow' as never);
  if (minutes < 60) return t('market.minutesAgo' as never, { count: minutes });
  return t('market.hoursAgo' as never, { count: Math.round(minutes / 60) });
}

export function MarketPanel() {
  const { t } = useLocale();
  const toast = useToast();

  const [pairs, setPairs] = useState<Pair[] | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    try {
      const data = await api.get<{ enabled: boolean; pairs: Pair[]; missing?: string[] }>('/api/market');
      setPairs(data.enabled ? data.pairs : []);
      setMissing(data.missing ?? []);
    } catch {
      setPairs([]);
    }
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const refresh = async () => {
    setBusy(true);
    try {
      const data = await api.post<{ pairs: Pair[]; missing?: string[] }>('/api/market', {});
      setPairs(data.pairs);
      setMissing(data.missing ?? []);
      toast.success(t('market.refreshed'), t('market.refreshedCount', { count: data.pairs.length }));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (pairs === null) return null;

  return (
    <div className="border-border-base space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">{t('market.showing')}</span>
        <Button
          size="sm"
          variant="secondary"
          icon={<RefreshCw className="size-4" />}
          onClick={refresh}
          loading={busy}
          className="ms-auto"
        >
          {t('market.refreshNow')}
        </Button>
      </div>

      {pairs.length === 0 ? (
        <Alert tone="warning">{t('market.nothing')}</Alert>
      ) : (
        <ul className="divide-border-subtle divide-y text-sm">
          {pairs.map((row) => (
            <li key={row.pair} className="flex flex-wrap items-center gap-3 py-2">
              <span dir="ltr" className="font-mono font-semibold">
                {row.pair}
              </span>
              <span dir="ltr" className="tabular-nums">
                {show(row.rate)}
              </span>
              {/*
                Which source answered, said plainly. A manager who turns the
                live source off should see these change to the reference, and a
                pair that quietly fell back should not look like the rest.
              */}
              <Badge tone={row.source === 'market' ? 'success' : 'neutral'}>
                {row.source === 'market' ? t('market.sourceLive') : t('market.sourceReference')}
              </Badge>
              <span className="text-content-tertiary ms-auto text-xs">{age(row.asOf, t as never)}</span>
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && (
        <Alert tone="warning">{t('market.missing', { pairs: missing.join('، ') })}</Alert>
      )}
    </div>
  );
}
