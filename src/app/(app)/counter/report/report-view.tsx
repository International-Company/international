'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/ui/primitives';
import { DateText, Money } from '@/ui/display';
import { useToast } from '@/ui/overlay';
import { CATEGORY_KEYS, type Category } from '@/modules/exchange/transaction-types';
import {
  CategoryCards,
  OperationsList,
  PeriodPicker,
  usePeriod,
  type TypeTotals,
} from '@/app/_activity/parts';

/**
 * What I did, and what it did to what I hold.
 *
 * ## The balances come first
 *
 * A teller's working question is "where do I stand", and the answer is the
 * balances in his hands — the same ones he will be counted on tonight. So they
 * open the page, split by why each moved: what the treasury handed him and
 * what he gave back frame the day; what came in and went out on his operations
 * is the day. Their difference is the one line that is his work.
 *
 * ## The same figures his manager sees
 *
 * The cards and the list are the manager's own components, fed the same
 * service narrowed to him. A teller who checks his report against the
 * manager's screen must find the same number, or the report is worse than none.
 */

interface Summary {
  counts: Record<Category, number>;
  total: number;
  reversed: number;
  lastAt: string | null;
}

interface Balance {
  currency: string;
  kind: string;
  decimals: number;
  handedIn: string;
  tradeIn: string;
  tradeOut: string;
  handedBack: string;
  other: string;
  balance: string;
}

interface Report {
  summary: Summary | null;
  types: TypeTotals[];
  balances: Balance[];
}

/** What to call a kind of balance — the drawers screen's own words. */
function kindLabel(kind: string) {
  if (kind === 'BROKER') return 'drawers.broker' as const;
  if (kind === 'CORRESPONDENT') return 'drawers.correspondent' as const;
  if (kind === 'DIFFERENCE') return 'drawers.difference' as const;
  if (kind === 'RECEIVABLE') return 'drawers.receivable' as const;
  return 'drawers.cash' as const;
}

export function MyReportView({ userId }: { userId: string }) {
  const { t } = useLocale();
  const toast = useToast();

  const period = usePeriod();
  const { range } = period;

  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(
        await api.get<Report>(
          `/api/my/activity${queryString({
            from: range.from.toISOString(),
            to: range.to.toISOString(),
          })}`,
        ),
      );
    } catch (error) {
      toast.error(
        t('errors.title'),
        error instanceof ApiError ? error.message : t('errors.generic'),
      );
    } finally {
      setLoading(false);
    }
  }, [range, t, toast]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const summary = report?.summary;

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('myReport.title')}
        description={t('myReport.subtitle')}
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw />}
            onClick={() => setReloadKey((key) => key + 1)}
            loading={loading}
          >
            {t('common.refresh')}
          </Button>
        }
      />

      <Card>
        <CardBody>
          <PeriodPicker period={period} />
        </CardBody>
      </Card>

      {/* --- At a glance ----------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('myReport.operations')} value={summary?.total ?? 0} strong />
        {CATEGORY_KEYS.map((key) => (
          <Stat key={key} label={t(`activity.category.${key}`)} value={summary?.counts[key] ?? 0} />
        ))}
      </div>
      {summary && (summary.reversed > 0 || summary.lastAt) && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-content-secondary">
          {summary.reversed > 0 && (
            <Badge tone="warning">{t('activity.reversedCount', { count: summary.reversed })}</Badge>
          )}
          {summary.lastAt && (
            <span>
              {t('activity.last')}: <DateText value={summary.lastAt} withTime />
            </span>
          )}
        </div>
      )}

      {/* --- Where I stand ---------------------------------------------------- */}
      <Card>
        <CardHeader title={t('myReport.balances')} description={t('myReport.balancesHint')} />
        <CardBody className="p-0">
          {!report || report.balances.length === 0 ? (
            <EmptyState title={loading ? t('common.loading') : t('myReport.noBalances')} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[48rem] border-collapse text-sm">
                <thead>
                  <tr className="bg-surface-sunken text-xs text-content-secondary">
                    <th className="px-3 py-2 text-start font-medium">{t('myReport.balance')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('myReport.handedIn')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('myReport.tradeIn')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('myReport.tradeOut')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('myReport.net')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('myReport.handedBack')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('myReport.now')}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.balances.map((row) => {
                    const net = BigInt(row.tradeIn) - BigInt(row.tradeOut);
                    const other = BigInt(row.other);
                    return (
                      <tr
                        key={`${row.currency}:${row.kind}`}
                        className="border-t border-border-subtle"
                      >
                        <td className="px-3 py-2">
                          <span className="font-medium ltr-content">{row.currency}</span>
                          <span className="ms-2 text-xs text-content-tertiary">
                            {t(kindLabel(row.kind))}
                          </span>
                          {other !== 0n && (
                            <div className="text-xs text-content-tertiary">
                              {t('myReport.other')}:{' '}
                              <Money value={other} decimals={row.decimals} colored signed />
                            </div>
                          )}
                        </td>
                        <Cell value={row.handedIn} decimals={row.decimals} />
                        <Cell value={row.tradeIn} decimals={row.decimals} />
                        <Cell value={row.tradeOut} decimals={row.decimals} />
                        <td className="px-3 py-2 text-end font-semibold tabular-nums ltr-content">
                          <Money value={net} decimals={row.decimals} colored signed />
                        </td>
                        <Cell value={row.handedBack} decimals={row.decimals} />
                        <td className="px-3 py-2 text-end font-bold tabular-nums ltr-content">
                          <Money value={row.balance} decimals={row.decimals} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* --- My work, by kind ------------------------------------------------- */}
      {report && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-content">{t('myReport.summary')}</h2>
          <CategoryCards types={report.types} />
        </section>
      )}

      <OperationsList
        range={range}
        createdById={userId}
        showStaff={false}
        title={t('myReport.list')}
        reloadKey={reloadKey}
      />
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <Card>
      <CardBody className="py-3">
        <p className="text-xs text-content-secondary">{label}</p>
        <p
          className={
            strong
              ? 'mt-1 text-2xl font-bold tabular-nums text-content'
              : 'mt-1 text-xl font-semibold tabular-nums text-content'
          }
        >
          {value}
        </p>
      </CardBody>
    </Card>
  );
}

/** A figure that is zero most days, drawn quietly when it is. */
function Cell({ value, decimals }: { value: string; decimals: number }) {
  return (
    <td className="px-3 py-2 text-end tabular-nums ltr-content">
      {BigInt(value) === 0n ? (
        <span className="text-content-tertiary">—</span>
      ) : (
        <Money value={value} decimals={decimals} />
      )}
    </td>
  );
}
