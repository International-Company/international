'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import type { CountryPrice, CountryTier } from '@/modules/whatsapp/country-prices';
import { Input, Select } from '@/ui/form';
import { Button, Card, CardBody, CardHeader } from '@/ui/primitives';

const emptyTier = (): CountryTier => ({
  from: '',
  to: '',
  cashRate: '',
  bankRate: '',
  cashFee: '',
  bankFee: '',
  feeKind: 'FLAT',
});

const NUMBER_FIELDS = ['from', 'to', 'cashRate', 'cashFee', 'bankRate', 'bankFee'] as const;

export function CountryPricesEditor({
  rows,
  disabled,
  onChange,
}: {
  rows: CountryPrice[];
  disabled: boolean;
  onChange: (rows: CountryPrice[]) => void;
}) {
  const { t } = useLocale();
  const change = (index: number, patch: Partial<CountryPrice>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const changeTier = (index: number, tier: number, patch: Partial<CountryTier>) =>
    change(index, {
      tiers: rows[index]!.tiers.map((item, at) => (at === tier ? { ...item, ...patch } : item)),
    });

  return (
    <Card>
      <CardHeader
        title={t('privateBot.countriesTitle')}
        description={t('privateBot.countriesHint')}
        actions={
          !disabled && rows.length < 40 ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus />}
              onClick={() => onChange([...rows, { country: '', unit: '', tiers: [emptyTier()] }])}
            >
              {t('privateBot.add')}
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-3">
        {rows.length === 0 && (
          <p className="text-sm text-content-tertiary">{t('privateBot.listEmpty')}</p>
        )}
        {rows.map((row, index) => (
          <div key={index} className="space-y-3 rounded-xl bg-surface-sunken p-3">
            <div className="flex items-center gap-2">
              <Input
                className="min-w-0 flex-1"
                maxLength={60}
                disabled={disabled}
                aria-label={t('privateBot.country')}
                placeholder={t('privateBot.country')}
                value={row.country}
                onChange={(event) => change(index, { country: event.target.value })}
              />
              <Input
                className="w-32 shrink-0"
                maxLength={20}
                disabled={disabled}
                aria-label={t('privateBot.countryUnit')}
                placeholder={t('privateBot.countryUnit')}
                value={row.unit}
                onChange={(event) => change(index, { unit: event.target.value })}
              />
              {!disabled && (
                <button
                  type="button"
                  aria-label={t('common.delete')}
                  onClick={() => onChange(rows.filter((_, at) => at !== index))}
                  className="flex size-10 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface hover:text-danger-text"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>

            {row.tiers.map((tier, position) => (
              <div key={position} className="flex items-end gap-2 rounded-lg bg-surface p-2">
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-7">
                  {NUMBER_FIELDS.map((field) => (
                    <label key={field} className="min-w-0">
                      <span className="mb-1 block truncate text-[11px] font-medium text-content-secondary">
                        {t(`privateBot.tier.${field}`)}
                      </span>
                      <Input
                        dir="ltr"
                        inputMode="decimal"
                        maxLength={20}
                        disabled={disabled}
                        value={tier[field]}
                        onChange={(event) =>
                          changeTier(index, position, { [field]: event.target.value })
                        }
                      />
                    </label>
                  ))}
                  <label className="min-w-0">
                    <span className="mb-1 block truncate text-[11px] font-medium text-content-secondary">
                      {t('privateBot.tier.feeKind')}
                    </span>
                    <Select
                      disabled={disabled}
                      value={tier.feeKind}
                      onChange={(event) =>
                        changeTier(index, position, {
                          feeKind: event.target.value as CountryTier['feeKind'],
                        })
                      }
                      options={[
                        { value: 'FLAT', label: t('privateBot.tier.flat') },
                        { value: 'PERCENT', label: '%' },
                      ]}
                    />
                  </label>
                </div>
                {!disabled && (
                  <button
                    type="button"
                    aria-label={t('common.delete')}
                    onClick={() =>
                      change(index, { tiers: row.tiers.filter((_, at) => at !== position) })
                    }
                    className="flex size-10 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-danger-text"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            ))}

            {!disabled && row.tiers.length < 15 && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Plus />}
                onClick={() => change(index, { tiers: [...row.tiers, emptyTier()] })}
              >
                {t('privateBot.addTier')}
              </Button>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
