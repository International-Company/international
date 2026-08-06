'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, FileSpreadsheet, Play, Printer } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { toISODate } from '@/i18n/format';
import { Button, Card, CardHeader, EmptyState, LoadingRows } from '@/ui/primitives';
import { Field, Input, Select } from '@/ui/form';
import { useToast } from '@/ui/overlay';
import { Money, Num } from '@/ui/display';
import { cn } from '@/ui/utils';
import type { ReportKey } from '@/modules/reports/reports.service';

interface ReportColumn {
  key: string;
  labelEn: string;
  labelAr: string;
  type: 'text' | 'money' | 'number' | 'date';
  currency?: string;
}

interface ReportResult {
  key: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
  generatedAt: string;
  range: { from: string; to: string };
}

/** Sensible default: the current calendar month to date. */
function defaultRange() {
  const now = new Date();
  return {
    from: toISODate(new Date(now.getFullYear(), now.getMonth(), 1)),
    to: toISODate(now),
  };
}

export function ReportsView({
  available,
  canExport,
}: {
  available: ReportKey[];
  canExport: boolean;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();

  const [reportKey, setReportKey] = useState<ReportKey>(available[0] ?? 'transactionSummary');
  const [range, setRange] = useState(defaultRange);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<ReportResult>(
        `/api/reports/${reportKey}${queryString({ from: range.from, to: range.to })}`,
      );
      setResult(data);
    } catch (error) {
      toast.error(
        t('errors.title'),
        error instanceof ApiError
          ? t(error.messageKey as never, error.params) || error.message
          : t('errors.generic'),
      );
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [reportKey, range, t, toast]);

  // Run once on mount and whenever the selected report changes, so the screen
  // is never a blank form waiting for a click.
  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportKey]);

  const exportUrl = (format: 'xlsx' | 'csv') =>
    `/api/reports/${reportKey}${queryString({ from: range.from, to: range.to, format })}`;

  const renderCell = (column: ReportColumn, row: Record<string, unknown>) => {
    const value = row[column.key];
    if (value === null || value === undefined) return '—';

    if (column.type === 'money') {
      const currency =
        column.currency === 'row' ? (row.currency as string | undefined) : column.currency;
      return <Money value={String(value)} currency={currency} />;
    }
    if (column.type === 'number') return <Num value={Number(value)} />;
    return String(value);
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col gap-3 p-3 lg:flex-row lg:items-end">
          <Field label={t('reports.run')} className="flex-1">
            {(props) => (
              <Select
                {...props}
                options={available.map((key) => ({
                  value: key,
                  label: t(`reports.${key}` as never),
                }))}
                value={reportKey}
                onChange={(event) => setReportKey(event.target.value as ReportKey)}
              />
            )}
          </Field>

          <Field label={t('reports.dateFrom')}>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={range.from}
                onChange={(event) => setRange({ ...range, from: event.target.value })}
                dir="ltr"
              />
            )}
          </Field>

          <Field label={t('reports.dateTo')}>
            {(props) => (
              <Input
                {...props}
                type="date"
                value={range.to}
                onChange={(event) => setRange({ ...range, to: event.target.value })}
                dir="ltr"
              />
            )}
          </Field>

          <div className="flex gap-2">
            <Button variant="primary" icon={<Play />} loading={loading} onClick={() => void run()}>
              {t('reports.run')}
            </Button>
            {canExport && result && result.rows.length > 0 && (
              <>
                <a href={exportUrl('xlsx')} download>
                  <Button variant="secondary" icon={<FileSpreadsheet />}>
                    <span className="hidden sm:inline">Excel</span>
                  </Button>
                </a>
                <a href={exportUrl('csv')} download>
                  <Button variant="secondary" icon={<Download />}>
                    <span className="hidden sm:inline">CSV</span>
                  </Button>
                </a>
                <Button
                  variant="secondary"
                  icon={<Printer />}
                  onClick={() => window.print()}
                  className="print-keep"
                >
                  <span className="hidden sm:inline">{t('common.print')}</span>
                </Button>
              </>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title={t(`reports.${reportKey}` as never)}
          description={t(`reports.${reportKey}Desc` as never)}
        />

        {loading ? (
          <LoadingRows rows={8} columns={5} />
        ) : !result || result.rows.length === 0 ? (
          <EmptyState title={t('reports.noData')} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border-base bg-surface-sunken">
                    {result.columns.map((column) => (
                      <th
                        key={column.key}
                        className={cn(
                          'px-4 py-2 text-xs font-medium text-content-secondary whitespace-nowrap',
                          column.type === 'money' || column.type === 'number'
                            ? 'text-end'
                            : 'text-start',
                        )}
                      >
                        {locale === 'ar' ? column.labelAr : column.labelEn}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-base">
                  {result.rows.map((row, index) => (
                    <tr key={index} className="hover:bg-surface-hover">
                      {result.columns.map((column) => (
                        <td
                          key={column.key}
                          className={cn(
                            'px-4 py-2 text-sm text-content',
                            column.type === 'money' || column.type === 'number'
                              ? 'text-end tabular-nums'
                              : 'text-start',
                          )}
                        >
                          {renderCell(column, row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {result.totals && Object.keys(result.totals).length > 0 && (
              <div className="flex flex-wrap gap-x-8 gap-y-2 border-t border-border-base bg-surface-sunken px-4 py-3">
                {Object.entries(result.totals).map(([key, value]) => (
                  <div key={key}>
                    <p className="text-xs text-content-secondary">
                      {t('common.total')} — {key}
                    </p>
                    <p className="text-sm font-semibold text-content tabular-nums">
                      {typeof value === 'object' && value !== null ? (
                        <Money value={String((value as { volume?: string }).volume ?? '0')} />
                      ) : (
                        <Money value={String(value)} />
                      )}
                    </p>
                  </div>
                ))}
              </div>
            )}

            <p className="px-4 py-2 text-xs text-content-tertiary">
              {t('reports.generatedAt', {
                datetime: new Date(result.generatedAt).toISOString().slice(0, 16).replace('T', ' '),
              })}
            </p>
          </>
        )}
      </Card>
    </div>
  );
}
