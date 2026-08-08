'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Button, Card, CardHeader, EmptyState } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, FormGrid, MoneyInput, Select, Textarea } from '@/ui/form';
import { DateText, Rate } from '@/ui/display';

interface BoardRow {
  id: string;
  baseCode: string;
  quoteCode: string;
  buyRate: string;
  sellRate: string;
  midRate: string;
  spread: string;
  effectiveFrom: string;
  source: string;
}

interface HistoryRow {
  id: string;
  baseCode: string;
  quoteCode: string;
  buyRate: string;
  sellRate: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  note: string | null;
  createdBy: { fullNameEn: string; fullNameAr: string } | null;
}

export function RatesView({
  board,
  history,
  currencies,
  canManage,
}: {
  board: BoardRow[];
  history: HistoryRow[];
  currencies: { code: string; nameEn: string; nameAr: string }[];
  canManage: boolean;
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [baseCode, setBaseCode] = useState(currencies[0]?.code ?? 'USD');
  const [quoteCode, setQuoteCode] = useState(currencies[1]?.code ?? 'ILS');
  const [buyRate, setBuyRate] = useState('');
  const [sellRate, setSellRate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currencyOptions = currencies.map((currency) => ({
    value: currency.code,
    label: `${currency.code} — ${ln(currency, 'name')}`,
  }));

  const publish = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.post('/api/exchange/rates', { baseCode, quoteCode, buyRate, sellRate, note });
      toast.success(t('common.saved'), `${baseCode}/${quoteCode}`);
      setOpen(false);
      setBuyRate('');
      setSellRate('');
      setNote('');
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? t(caught.messageKey as never, caught.params) || caught.message
          : t('errors.generic'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t('rates.current')}
          actions={
            canManage && (
              <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setOpen(true)}>
                {t('rates.publish')}
              </Button>
            )
          }
        />

        {board.length === 0 ? (
          <EmptyState title={t('rates.noRates')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-base bg-surface-sunken">
                  <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                    {t('rates.pair')}
                  </th>
                  <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                    {t('rates.buyRate')}
                  </th>
                  <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                    {t('rates.sellRate')}
                  </th>
                  <th className="hidden px-4 py-2 text-end text-xs font-medium text-content-secondary sm:table-cell">
                    {t('rates.spread')}
                  </th>
                  <th className="hidden px-4 py-2 text-end text-xs font-medium text-content-secondary sm:table-cell">
                    {t('rates.effectiveFrom')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-base">
                {board.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-hover">
                    <td className="px-4 py-2.5 text-sm font-medium text-content ltr-content">
                      {row.baseCode}/{row.quoteCode}
                    </td>
                    <td className="px-4 py-2.5 text-end text-sm text-content">
                      <Rate value={row.buyRate} />
                    </td>
                    <td className="px-4 py-2.5 text-end text-sm text-content">
                      <Rate value={row.sellRate} />
                    </td>
                    <td className="hidden px-4 py-2.5 text-end text-sm text-content-secondary sm:table-cell">
                      <Rate value={row.spread} />
                    </td>
                    <td className="hidden px-4 py-2.5 text-end text-xs text-content-tertiary sm:table-cell">
                      <DateText value={row.effectiveFrom} withTime />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={t('rates.history')} description={t('rates.publishHint')} />
        {history.length === 0 ? (
          <EmptyState title={t('common.noResults')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-base bg-surface-sunken">
                  <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                    {t('rates.pair')}
                  </th>
                  <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                    {t('rates.buyRate')}
                  </th>
                  <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                    {t('rates.sellRate')}
                  </th>
                  <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                    {t('rates.effectiveFrom')}
                  </th>
                  <th className="hidden px-4 py-2 text-start text-xs font-medium text-content-secondary sm:table-cell">
                    {t('rates.effectiveTo')}
                  </th>
                  <th className="hidden px-4 py-2 text-start text-xs font-medium text-content-secondary sm:table-cell">
                    {t('rates.changedBy')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-base">
                {history.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-2 text-sm text-content ltr-content">
                      {row.baseCode}/{row.quoteCode}
                    </td>
                    <td className="px-4 py-2 text-end text-sm">
                      <Rate value={row.buyRate} />
                    </td>
                    <td className="px-4 py-2 text-end text-sm">
                      <Rate value={row.sellRate} />
                    </td>
                    <td className="px-4 py-2 text-xs text-content-secondary">
                      <DateText value={row.effectiveFrom} withTime />
                    </td>
                    <td className="hidden px-4 py-2 text-xs text-content-secondary sm:table-cell">
                      {row.effectiveTo ? (
                        <DateText value={row.effectiveTo} withTime />
                      ) : (
                        <span className="text-success-text">{t('rates.current')}</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-2 text-xs text-content-tertiary sm:table-cell">
                      {row.createdBy ? ln(row.createdBy, 'fullName') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('rates.publishTitle')}
        description={t('rates.publishHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!buyRate || !sellRate}
              onClick={() => void publish()}
            >
              {t('rates.publish')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <p className="text-sm text-danger-text">{error}</p>}

          <FormGrid columns={2}>
            <Field label={t('rates.baseCurrency')} required>
              {(props) => (
                <Select
                  {...props}
                  options={currencyOptions}
                  value={baseCode}
                  onChange={(event) => setBaseCode(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('rates.quoteCurrency')} required>
              {(props) => (
                <Select
                  {...props}
                  options={currencyOptions}
                  value={quoteCode}
                  onChange={(event) => setQuoteCode(event.target.value)}
                />
              )}
            </Field>
          </FormGrid>

          <FormGrid columns={2}>
            <Field label={t('rates.buyRate')} hint={t('rates.buyHint', { base: baseCode })} required>
              {(props) => (
                <MoneyInput
                  {...props}
                  value={buyRate}
                  onValueChange={setBuyRate}
                  decimals={6}
                  placeholder="0.0000"
                />
              )}
            </Field>
            <Field
              label={t('rates.sellRate')}
              hint={t('rates.sellHint', { base: baseCode })}
              required
            >
              {(props) => (
                <MoneyInput
                  {...props}
                  value={sellRate}
                  onValueChange={setSellRate}
                  decimals={6}
                  placeholder="0.0000"
                />
              )}
            </Field>
          </FormGrid>

          <Field label={t('rates.note')} optionalLabel={t('common.optional')}>
            {(props) => (
              <Textarea
                {...props}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
