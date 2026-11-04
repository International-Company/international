'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Tags, Trash2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { normalizeDigits } from '@/core/money/money';
import { Button } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';

/**
 * The price list, kept where it is used: under the remittance form, for whoever
 * manages rates. One row per destination and currency; saving the same pair
 * again replaces its row.
 */

export interface PriceRow {
  id: string;
  destination: string;
  currency: string;
  chargeKind: string;
  chargeValue: string;
  costKind: string;
  costValue: string;
}

const clean = (raw: string) => {
  const cleaned = normalizeDigits(raw)
    .replace(/[,٫]/g, '.')
    .replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  return rest.length > 0 ? `${whole}.${rest.join('').slice(0, 4)}` : whole;
};

const shown = (kind: string, value: string) => {
  const digits = value.padStart(9, '0');
  const fraction = digits.slice(-8).replace(/0+$/, '');
  const figure = `${digits.slice(0, -8)}${fraction ? `.${fraction}` : ''}`;
  return kind === 'PERCENT' ? `${figure}%` : figure;
};

const field =
  'mt-1 h-11 w-full min-w-0 rounded-xl bg-surface-sunken px-3 text-sm font-medium text-content outline-none ring-1 ring-transparent focus:ring-primary';

export function RemittancePrices({
  prices,
  destinations,
  currencies,
}: {
  prices: PriceRow[];
  destinations: string[];
  currencies: string[];
}) {
  const { t } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [destination, setDestination] = useState(destinations[0] ?? '');
  const [currency, setCurrency] = useState(currencies[0] ?? '');
  const [chargeKind, setChargeKind] = useState<'FLAT' | 'PERCENT'>('FLAT');
  const [chargeValue, setChargeValue] = useState('');
  const [costKind, setCostKind] = useState<'FLAT' | 'PERCENT'>('FLAT');
  const [costValue, setCostValue] = useState('');
  const [busy, setBusy] = useState(false);

  const call = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api.post('/api/exchange/remittance/prices', body);
      toast.success(t('common.saved'));
      setChargeValue('');
      setCostValue('');
      router.refresh();
    } catch (cause) {
      const failure = describeFailure(cause, t as never);
      toast.error(failure.title, failure.body);
    } finally {
      setBusy(false);
    }
  };

  const kinds = (
    <>
      <option value="FLAT">{t('remittance.feeFlat')}</option>
      <option value="PERCENT">{t('remittance.feePercent')}</option>
    </>
  );

  return (
    <section className="mx-auto w-full max-w-xl space-y-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-content">
        <Tags className="size-4 text-primary-text" />
        {t('remittance.pricesTitle')}
      </h3>

      {prices.length > 0 && (
        <ul className="divide-y divide-border-subtle text-sm">
          {prices.map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="font-medium text-content">
                  {row.destination} · <span className="ltr-content">{row.currency}</span>
                </p>
                <p className="text-xs text-content-tertiary">
                  {t('remittance.officeFee')}{' '}
                  <span className="ltr-content tabular-nums">
                    {shown(row.chargeKind, row.chargeValue)}
                  </span>
                  {' · '}
                  {t('remittance.correspondentFee')}{' '}
                  <span className="ltr-content tabular-nums">
                    {shown(row.costKind, row.costValue)}
                  </span>
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void call({ action: 'delete', id: row.id })}
                aria-label={t('common.delete')}
                title={t('common.delete')}
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-danger-subtle hover:text-danger-text"
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-content-tertiary">{t('remittance.destination')}</span>
          <select
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            className={field}
          >
            {destinations.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-content-tertiary">{t('remittance.currency')}</span>
          <select
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
            className={field}
          >
            {currencies.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-content-tertiary">{t('remittance.officeFee')}</span>
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            value={chargeValue}
            onChange={(event) => setChargeValue(clean(event.target.value))}
            className={`${field} text-end tabular-nums`}
          />
          <select
            aria-label={t('remittance.officeFee')}
            value={chargeKind}
            onChange={(event) => setChargeKind(event.target.value as 'FLAT' | 'PERCENT')}
            className={field}
          >
            {kinds}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-content-tertiary">{t('remittance.correspondentFee')}</span>
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            value={costValue}
            onChange={(event) => setCostValue(clean(event.target.value))}
            className={`${field} text-end tabular-nums`}
          />
          <select
            aria-label={t('remittance.correspondentFee')}
            value={costKind}
            onChange={(event) => setCostKind(event.target.value as 'FLAT' | 'PERCENT')}
            className={field}
          >
            {kinds}
          </select>
        </label>
      </div>

      <Button
        type="button"
        variant="secondary"
        loading={busy}
        disabled={!destination || !currency || !chargeValue || !costValue}
        onClick={() =>
          void call({
            action: 'save',
            destination,
            currency,
            chargeKind,
            chargeValue,
            costKind,
            costValue,
          })
        }
      >
        {t('remittance.savePrice')}
      </Button>
    </section>
  );
}
