'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/ui/primitives';
import { Select } from '@/ui/form';
import { DateText } from '@/ui/display';
import { useToast } from '@/ui/overlay';
import { cn } from '@/ui/utils';
import { CATEGORY_KEYS, type Category } from '@/modules/exchange/transaction-types';
import {
  CategoryCards,
  OperationsList,
  PeriodPicker,
  SpecialPrices,
  usePeriod,
  type Amount,
  type SpecialPriceDeal,
  type TypeTotals,
} from '@/app/_activity/parts';
import { DailyLedger } from '@/app/_activity/daily-ledger';

/**
 * What each teller recorded, and what it came to.
 *
 * ## Read top to bottom, the way the question narrows
 *
 * Who worked, and how much of each kind (the table). Then, for one of them or
 * for everybody, what those deals added up to in each currency (the three
 * cards). Then the deals themselves, one click from each transaction's own page
 * (the list). Picking a teller in the table narrows the two below it; nothing
 * on the page asks the manager to choose the same person twice.
 *
 * ## Why no grand total in one currency
 *
 * Summing dollars and shekels needs a rate, and any rate chosen here would be a
 * guess about a day that is over. The ledger is where the office is valued in
 * one currency, with the cut-off rates written beside it.
 */

interface TellerSummary {
  tellerId: string;
  fullNameEn: string;
  fullNameAr: string;
  counts: Record<Category, number>;
  total: number;
  reversed: number;
  special: number;
  lastAt: string | null;
}

interface Activity {
  tellers: TellerSummary[];
  types: TypeTotals[];
  specialPrices: SpecialPriceDeal[];
  specialConceded: Amount[];
  canSeeMargin: boolean;
}

export function ActivityView({ initialTeller }: { initialTeller: string }) {
  const { t, ln } = useLocale();
  const toast = useToast();

  const period = usePeriod();
  const { range } = period;
  const [tellerId, setTellerId] = useState(initialTeller);

  const [data, setData] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await api.get<Activity>(
          `/api/manage/activity${queryString({
            from: range.from.toISOString(),
            to: range.to.toISOString(),
            tellerId,
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
  }, [range, tellerId, t, toast]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const tellers = data?.tellers ?? [];
  const chosen = tellers.find((teller) => teller.tellerId === tellerId) ?? null;
  const name = (row: { fullNameEn: string; fullNameAr: string }) => ln(row, 'fullName');

  const sums = useMemo(
    () =>
      tellers.reduce(
        (acc, teller) => ({
          EXCHANGE: acc.EXCHANGE + teller.counts.EXCHANGE,
          REMITTANCE: acc.REMITTANCE + teller.counts.REMITTANCE,
          USDT: acc.USDT + teller.counts.USDT,
          total: acc.total + teller.total,
          reversed: acc.reversed + teller.reversed,
          special: acc.special + teller.special,
        }),
        { EXCHANGE: 0, REMITTANCE: 0, USDT: 0, total: 0, reversed: 0, special: 0 },
      ),
    [tellers],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('activity.title')}
        description={t('activity.subtitle')}
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

      {/* --- The question: when, and who ---------------------------------- */}
      <Card>
        <CardBody className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <PeriodPicker period={period} />

          <label className="flex flex-col gap-1 text-xs lg:ms-auto lg:w-64">
            <span className="text-content-secondary">{t('activity.teller')}</span>
            <Select
              value={tellerId}
              onChange={(event) => setTellerId(event.target.value)}
              options={[
                { value: '', label: t('activity.everyone') },
                ...tellers.map((teller) => ({ value: teller.tellerId, label: name(teller) })),
                // Kept selectable when he recorded nothing in this window, so
                // the choice survives changing the period.
                ...(tellerId && !chosen ? [{ value: tellerId, label: '—' }] : []),
              ]}
            />
          </label>
        </CardBody>
      </Card>

      {/* --- Who worked, and how much of each kind --------------------------- */}
      <Card>
        <CardHeader title={t('activity.who')} />
        <CardBody className="p-0">
          {tellers.length === 0 ? (
            <EmptyState
              title={loading ? t('common.loading') : t('activity.noneTitle')}
              description={loading ? undefined : t('activity.noneHint')}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] border-collapse text-sm">
                <thead>
                  <tr className="bg-surface-sunken text-xs text-content-secondary">
                    <th className="px-3 py-2 text-start font-medium">{t('activity.who')}</th>
                    {CATEGORY_KEYS.map((key) => (
                      <th key={key} className="px-3 py-2 text-end font-medium">
                        {t(`activity.category.${key}`)}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-end font-medium">{t('activity.total')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('activity.reversed')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('activity.special')}</th>
                    <th className="px-3 py-2 text-end font-medium">{t('activity.last')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tellers.map((teller) => {
                    const selected = teller.tellerId === tellerId;
                    return (
                      <tr
                        key={teller.tellerId}
                        onClick={() => setTellerId(selected ? '' : teller.tellerId)}
                        aria-selected={selected}
                        className={cn(
                          'cursor-pointer border-t border-border-subtle transition-colors',
                          selected ? 'bg-primary-subtle' : 'hover:bg-surface-hover',
                        )}
                      >
                        <td className="px-3 py-2 font-medium">{name(teller)}</td>
                        {CATEGORY_KEYS.map((key) => (
                          <td key={key} className="px-3 py-2 text-end tabular-nums">
                            {teller.counts[key] || <span className="text-content-tertiary">0</span>}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-end font-bold tabular-nums">
                          {teller.total}
                        </td>
                        <td className="px-3 py-2 text-end tabular-nums">
                          {teller.reversed > 0 ? (
                            <Badge tone="warning">{teller.reversed}</Badge>
                          ) : (
                            <span className="text-content-tertiary">0</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-end tabular-nums">
                          {teller.special > 0 ? (
                            <Badge tone="warning">{teller.special}</Badge>
                          ) : (
                            <span className="text-content-tertiary">0</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-end text-xs text-content-secondary">
                          <DateText value={teller.lastAt} withTime />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {tellers.length > 1 && (
                  <tfoot>
                    <tr className="border-t-2 border-border-base bg-surface-sunken font-semibold">
                      <td className="px-3 py-2">{t('activity.total')}</td>
                      {CATEGORY_KEYS.map((key) => (
                        <td key={key} className="px-3 py-2 text-end tabular-nums">
                          {sums[key]}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-end tabular-nums">{sums.total}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{sums.reversed}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{sums.special}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* --- What it came to ------------------------------------------------- */}
      {data && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-content">
              {chosen
                ? t('activity.breakdownFor', { name: name(chosen) })
                : t('activity.breakdownAll')}
            </h2>
            {tellerId && (
              <Button size="sm" variant="ghost" onClick={() => setTellerId('')}>
                {t('activity.showEveryone')}
              </Button>
            )}
          </div>
          <CategoryCards types={data.types} />
        </section>
      )}

      {/* --- Deals at a special price, apart from the rest --------------------- */}
      {data && (
        <SpecialPrices
          deals={data.specialPrices}
          conceded={data.specialConceded}
          showStaff={!tellerId}
          title={
            chosen ? t('activity.specialFor', { name: name(chosen) }) : t('activity.specialTitle')
          }
        />
      )}

      {/* --- The deals themselves ------------------------------------------- */}
      {/* One teller chosen: his days, with what he owed the bank at each end. */}
      {chosen && (
        <DailyLedger
          days={30}
          tellerId={chosen.tellerId}
          title={t('ledgerDays.titleFor', { name: name(chosen) })}
          refreshKey={reloadKey}
        />
      )}

      <OperationsList
        range={range}
        createdById={tellerId || undefined}
        showStaff={!tellerId}
        title={chosen ? t('activity.listFor', { name: name(chosen) }) : t('activity.list')}
        reloadKey={reloadKey}
      />
    </div>
  );
}
