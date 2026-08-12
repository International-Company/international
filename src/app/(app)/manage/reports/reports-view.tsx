'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { Button, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { formatAmount, formatDateTime } from '@/i18n/format';

/**
 * One screen for every report, driven by the report's own column list.
 *
 * There is no per-report layout here, and that is the point: a report is a
 * definition on the server, and the screen, the spreadsheet and the print page
 * all render whatever it says its columns are. Adding a report is adding a
 * definition; nothing here has to learn about it.
 */

interface Column {
  key: string;
  labelEn: string;
  labelAr: string;
  kind: 'text' | 'money' | 'rate' | 'date' | 'number' | 'code';
  currencyKey?: string;
}

interface Ran {
  key: string;
  nameEn: string;
  nameAr: string;
  columns: Column[];
  rows: Record<string, string | number | null>[];
  count: number;
}

const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

export function ReportsView({
  available,
}: {
  available: { key: string; nameEn: string; nameAr: string }[];
}) {
  const { t, ln, locale } = useLocale();
  const toast = useToast();

  const [chosen, setChosen] = useState(available[0]?.key ?? '');
  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [ran, setRan] = useState<Ran | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useCallback(
    () => `from=${from}&to=${to}&locale=${locale}`,
    [from, to, locale],
  );

  const load = useCallback(async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      setRan(await api.get<Ran>(`/api/reports/${chosen}?${query()}`));
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : String(error));
      setRan(null);
    } finally {
      setBusy(false);
    }
  }, [chosen, query, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const cell = (row: Record<string, string | number | null>, column: Column) => {
    const value = row[`${column.key}${locale === 'ar' ? 'Ar' : 'En'}`] ?? row[column.key];
    if (value === null || value === undefined || value === '') return '—';

    if (column.kind === 'money') {
      const currency = column.currencyKey ? String(row[column.currencyKey] ?? '') : undefined;
      return formatAmount(String(value), locale, { currency, decimals: currency === 'JOD' ? 3 : 2 });
    }
    if (column.kind === 'rate') return formatAmount(String(value), locale, { decimals: 4 });
    if (column.kind === 'date') return formatDateTime(String(value), locale);
    return String(value);
  };

  const numeric = (kind: Column['kind']) => kind === 'money' || kind === 'rate' || kind === 'number';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t('reports.pick')}
          description={t('reports.pickHint')}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<Download className="size-4" />}
                disabled={!ran || ran.count === 0}
                onClick={() => {
                  window.location.href = `/api/reports/${chosen}?${query()}&format=xlsx`;
                }}
              >
                {t('reports.excel')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Printer className="size-4" />}
                disabled={!ran || ran.count === 0}
                onClick={() => window.open(`/print/report/${chosen}?${query()}`, '_blank')}
              >
                {t('reports.print')}
              </Button>
            </div>
          }
        />
        <CardBody>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-content-secondary">{t('reports.report')}</span>
              <select
                value={chosen}
                onChange={(event) => setChosen(event.target.value)}
                className="bg-surface border-border-base h-9 rounded-lg border px-2 text-sm"
              >
                {available.map((report) => (
                  <option key={report.key} value={report.key}>
                    {ln(report, 'name')}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-content-secondary">{t('reports.dateFrom')}</span>
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="bg-surface border-border-base h-9 rounded-lg border px-2 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="text-content-secondary">{t('reports.dateTo')}</span>
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="bg-surface border-border-base h-9 rounded-lg border px-2 text-sm"
              />
            </label>

            <span className="text-content-tertiary ms-auto text-xs">
              {ran ? t('reports.rows', { count: ran.count }) : ''}
            </span>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {!ran || ran.count === 0 ? (
            <EmptyState
              title={busy ? t('common.loading') : t('reports.noData')}
              description={busy ? undefined : t('reports.emptyHint')}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-surface-sunken text-content-secondary text-xs">
                    {ran.columns.map((column) => (
                      <th
                        key={column.key}
                        className={`px-3 py-2 font-medium whitespace-nowrap ${
                          numeric(column.kind) ? 'text-end' : 'text-start'
                        }`}
                      >
                        {ln(column, 'label')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ran.rows.map((row, index) => (
                    <tr key={index} className="border-border-subtle border-t">
                      {ran.columns.map((column) => (
                        <td
                          key={column.key}
                          className={`px-3 py-2 whitespace-nowrap ${
                            numeric(column.kind)
                              ? 'text-end tabular-nums ltr-content'
                              : 'text-start'
                          }`}
                        >
                          {cell(row, column)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
