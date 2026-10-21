'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale } from '@/i18n/provider';
import { api, ApiError, queryString } from '@/lib/api-client';
import { Alert, Badge, Card, CardBody, CardHeader } from '@/ui/primitives';
import { DataTable, type Column } from '@/ui/data-table';
import { DateText, Money, StatusBadge, TransactionTypeBadge } from '@/ui/display';
import { useToast } from '@/ui/overlay';
import { cn } from '@/ui/utils';
import { CATEGORIES, CATEGORY_KEYS, type Category } from '@/modules/exchange/transaction-types';

/**
 * The pieces the manager's view of everybody and a teller's view of himself
 * share.
 *
 * One set, so the two cannot drift: a teller who reads "استلم 4,200 شيكل" on his
 * own report must find the same figure, worked out the same way, on the screen
 * his manager judges him by.
 */

export interface Amount {
  currency: string;
  amount: string;
}

export interface TypeTotals {
  type: string;
  count: number;
  pending: number;
  reversed: number;
  received: Amount[];
  paid: Amount[];
  margin: Amount[] | null;
}

// --- The period ---------------------------------------------------------------

export const PRESETS = ['today', 'yesterday', 'week', 'month', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];

/** A date input's value for a local day. */
const dayString = (date: Date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

/**
 * The window a preset means, in the office's own time.
 *
 * Whole local days: "today" is from this morning's midnight at the counter,
 * not from midnight in Greenwich, which in this timezone would cut two or three
 * hours off one end of the day and add them to the other.
 */
function windowFor(preset: Preset, customFrom: string, customTo: string): { from: Date; to: Date } {
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const endOf = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  const now = new Date();

  switch (preset) {
    case 'today':
      return { from: startOf(now), to: endOf(now) };
    case 'yesterday': {
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      return { from: startOf(yesterday), to: endOf(yesterday) };
    }
    case 'week':
      return {
        from: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6),
        to: endOf(now),
      };
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOf(now) };
    case 'custom': {
      const [fy, fm, fd] = customFrom.split('-').map(Number);
      const [ty, tm, td] = customTo.split('-').map(Number);
      return {
        from: new Date(fy ?? now.getFullYear(), (fm ?? 1) - 1, fd ?? 1),
        to: new Date(ty ?? now.getFullYear(), (tm ?? 1) - 1, td ?? 1, 23, 59, 59, 999),
      };
    }
  }
}

/** The chosen period, and the window it means. */
export function usePeriod(initial: Preset = 'today') {
  const [preset, setPreset] = useState<Preset>(initial);
  const [customFrom, setCustomFrom] = useState(() => dayString(new Date()));
  const [customTo, setCustomTo] = useState(() => dayString(new Date()));

  // Recomputed only when the choice changes, so "today" does not drift forward
  // a millisecond on every render and refetch forever.
  const range = useMemo(
    () => windowFor(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  return { preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, range };
}

export function PeriodPicker({ period }: { period: ReturnType<typeof usePeriod> }) {
  const { t } = useLocale();
  const { preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo } = period;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="flex flex-col gap-1">
        <span className="text-xs text-content-secondary">{t('activity.period')}</span>
        <div
          role="radiogroup"
          aria-label={t('activity.period')}
          className="flex flex-wrap gap-1 rounded-[var(--radius-control)] bg-surface-sunken p-1"
        >
          {PRESETS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={preset === value}
              onClick={() => setPreset(value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm transition-colors',
                preset === value
                  ? 'bg-surface font-medium text-content shadow-sm'
                  : 'text-content-secondary hover:text-content',
              )}
            >
              {t(`activity.${value}`)}
            </button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-content-secondary">{t('activity.from')}</span>
            <input
              type="date"
              value={customFrom}
              max={customTo}
              onChange={(event) => setCustomFrom(event.target.value)}
              className="h-9 rounded-lg border border-border-base bg-surface px-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-content-secondary">{t('activity.to')}</span>
            <input
              type="date"
              value={customTo}
              min={customFrom}
              onChange={(event) => setCustomTo(event.target.value)}
              className="h-9 rounded-lg border border-border-base bg-surface px-2 text-sm"
            />
          </label>
        </div>
      )}
    </div>
  );
}

// --- What it came to ------------------------------------------------------------

/** The three kinds of work side by side, and the one rule that governs them. */
export function CategoryCards({ types }: { types: TypeTotals[] }) {
  const { t } = useLocale();
  return (
    <>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {CATEGORY_KEYS.map((key) => (
          <CategoryCard
            key={key}
            category={key}
            types={types.filter((totals) =>
              (CATEGORIES[key] as readonly string[]).includes(totals.type),
            )}
          />
        ))}
      </div>
      <Alert tone="neutral">{t('activity.perCurrency')}</Alert>
    </>
  );
}

/** One kind of work — صرافة، حوالات، USDT — and what its deals came to. */
function CategoryCard({ category: key, types }: { category: Category; types: TypeTotals[] }) {
  const { t } = useLocale();
  const count = types.reduce((sum, totals) => sum + totals.count, 0);
  // A kind with two directions names each; one with a single type does not
  // repeat its own heading underneath itself.
  const split = types.length > 1;

  return (
    <Card>
      <CardHeader
        title={t(`activity.category.${key}`)}
        actions={
          <Badge tone={count > 0 ? 'primary' : 'neutral'}>
            {t('activity.operations', { count })}
          </Badge>
        }
      />
      <CardBody className="space-y-4">
        {types.map((totals) => (
          <div key={totals.type} className="space-y-2">
            {split && (
              <div className="flex items-center justify-between gap-2">
                <TransactionTypeBadge type={totals.type} />
                <span className="text-xs text-content-secondary tabular-nums">
                  {t('activity.operations', { count: totals.count })}
                </span>
              </div>
            )}

            {totals.count === 0 ? (
              <p className="text-sm text-content-tertiary">{t('activity.nothing')}</p>
            ) : (
              <dl className="space-y-1.5 text-sm">
                <AmountRow label={t('activity.received')} amounts={totals.received} />
                <AmountRow label={t('activity.paid')} amounts={totals.paid} />
                {totals.margin && (
                  <AmountRow label={t('activity.margin')} amounts={totals.margin} colored />
                )}
              </dl>
            )}

            {(totals.pending > 0 || totals.reversed > 0) && (
              <div className="flex flex-wrap gap-1.5">
                {totals.pending > 0 && (
                  <Badge tone="warning">{t('activity.pending', { count: totals.pending })}</Badge>
                )}
                {totals.reversed > 0 && (
                  <Badge tone="neutral">
                    {t('activity.reversedCount', { count: totals.reversed })}
                  </Badge>
                )}
              </div>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

/** One label against one or more currencies, each on its own line. */
function AmountRow({
  label,
  amounts,
  colored,
}: {
  label: string;
  amounts: Amount[];
  colored?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-content-secondary">{label}</dt>
      <dd className="text-end font-medium">
        {amounts.map((entry) => (
          <div key={entry.currency} className="ltr-content tabular-nums">
            <Money
              value={entry.amount}
              currency={entry.currency}
              decimals={entry.currency === 'JOD' ? 3 : 2}
              colored={colored}
            />
          </div>
        ))}
      </dd>
    </div>
  );
}

// --- The deals themselves --------------------------------------------------------

interface TransactionRow {
  id: string;
  reference: string;
  type: string;
  status: string;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  createdAt: string;
  createdBy: { fullNameEn: string; fullNameAr: string };
}

interface ListResponse {
  rows: TransactionRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * The deals in a window, by kind, each one click from its own page.
 *
 * Reads the ordinary transactions list, which already keeps a teller to his own
 * work — so the same component is safe on both screens without a rule of its
 * own about whose rows it may show.
 */
export function OperationsList({
  range,
  createdById,
  showStaff,
  title,
  reloadKey,
}: {
  range: { from: Date; to: Date };
  createdById?: string;
  /** The staff column, when the list holds more than one person's work. */
  showStaff: boolean;
  title: string;
  /** Bumped by the page's refresh button. */
  reloadKey?: number;
}) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [category, setCategory] = useState<Category | ''>('');
  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // A new question starts the list from its first page.
  useEffect(() => {
    setPage(1);
  }, [range, createdById, category]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setList(
        await api.get<ListResponse>(
          `/api/manage/transactions${queryString({
            from: range.from.toISOString(),
            to: range.to.toISOString(),
            createdById,
            category,
            page,
            pageSize,
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
  }, [range, createdById, category, page, pageSize, t, toast]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const columns: Column<TransactionRow>[] = [
    {
      key: 'reference',
      header: t('transactions.reference'),
      cell: (row) => (
        <span className="font-mono text-xs font-medium text-primary-text ltr-content">
          {row.reference}
        </span>
      ),
    },
    {
      key: 'type',
      header: t('common.type'),
      cell: (row) => <TransactionTypeBadge type={row.type} />,
      hideOnMobile: true,
    },
    ...(showStaff
      ? [
          {
            key: 'staff',
            header: t('transactions.staff'),
            cell: (row: TransactionRow) => (
              <span className="text-sm">{ln(row.createdBy, 'fullName')}</span>
            ),
            hideOnMobile: true,
          },
        ]
      : []),
    {
      key: 'amount',
      header: t('common.amount'),
      align: 'end',
      numeric: true,
      cell: (row) => (
        <div>
          <Money value={row.fromAmount} currency={row.fromCurrency} className="font-medium" />
          {row.toCurrency !== row.fromCurrency && (
            <div className="text-xs text-content-tertiary">
              → <Money value={row.toAmount} currency={row.toCurrency} />
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: t('common.status'),
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: 'createdAt',
      header: t('common.createdAt'),
      align: 'end',
      cell: (row) => (
        <span className="text-xs text-content-secondary">
          <DateText value={row.createdAt} withTime />
        </span>
      ),
      hideOnMobile: true,
    },
  ];

  return (
    <Card>
      <div className="flex flex-col gap-3 border-b border-border-base p-3 sm:flex-row sm:items-center">
        <h2 className="text-sm font-semibold text-content">{title}</h2>
        <div role="tablist" className="flex flex-wrap gap-1 sm:ms-auto">
          {(['', ...CATEGORY_KEYS] as const).map((key) => (
            <button
              key={key || 'all'}
              type="button"
              role="tab"
              aria-selected={category === key}
              onClick={() => setCategory(key)}
              className={cn(
                'rounded-full px-3 py-1 text-xs transition-colors',
                category === key
                  ? 'bg-primary text-content-inverse'
                  : 'bg-surface-sunken text-content-secondary hover:text-content',
              )}
            >
              {key ? t(`activity.category.${key}`) : t('activity.all')}
            </button>
          ))}
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={list?.rows ?? []}
        rowKey={(row) => row.id}
        loading={loading}
        onRowClick={(row) => router.push(`/manage/transactions/${row.id}`)}
        emptyTitle={t('activity.noneTitle')}
        emptyDescription={t('activity.noneHint')}
        pagination={{
          page: list?.page ?? 1,
          pageSize: list?.pageSize ?? pageSize,
          total: list?.total ?? 0,
          pageCount: list?.pageCount ?? 1,
          onPageChange: setPage,
          onPageSizeChange: (size) => {
            setPageSize(size);
            setPage(1);
          },
        }}
      />
    </Card>
  );
}
