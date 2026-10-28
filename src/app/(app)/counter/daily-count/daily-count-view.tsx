'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  Coins,
  HandCoins,
  Printer,
  Search,
  ShoppingCart,
  type LucideIcon,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { Badge, LoadingRows } from '@/ui/primitives';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';
import { DayNavigator, dayInput } from '../machine/my-cash-ledger';

/**
 * The day in two lists — USDT and exchange — chosen by a tab. Each list opens
 * with its two kinds side by side (received and sent, bought and sold), which
 * double as its filter, and beneath them every deal of the list in one table:
 * the kind, the customer, how much of the goods, the price, and the other side.
 */

interface Amount {
  currency: string;
  amount: string;
}

type Kind = 'USDT_RECEIVE' | 'USDT_SEND' | 'BUY' | 'SELL';
type Tab = 'USDT' | 'EXCHANGE';

interface Entry {
  id: string;
  reference: string;
  at: string;
  status: string;
  customer: string | null;
  fromCurrency: string;
  fromAmount: string;
  toCurrency: string;
  toAmount: string;
  payoutBank: string;
  payoutChannel: string | null;
  reversed: boolean;
}

interface Group {
  kind: Kind;
  count: number;
  received: Amount[];
  paid: Amount[];
  entries: Entry[];
}

const TABS: { tab: Tab; icon: LucideIcon; kinds: [Kind, Kind] }[] = [
  { tab: 'USDT', icon: Coins, kinds: ['USDT_RECEIVE', 'USDT_SEND'] },
  { tab: 'EXCHANGE', icon: ArrowLeftRight, kinds: ['BUY', 'SELL'] },
];

/** How each kind reads: icon, colour, and which side of the deal is the goods. */
const LOOK: Record<
  Kind,
  { icon: LucideIcon; tone: string; active: string; goodsOn: 'from' | 'to' }
> = {
  USDT_RECEIVE: {
    icon: ArrowDownToLine,
    tone: 'text-success-text bg-success-subtle',
    active: 'ring-2 ring-success',
    goodsOn: 'from',
  },
  USDT_SEND: {
    icon: ArrowUpFromLine,
    tone: 'text-warning-text bg-warning-subtle',
    active: 'ring-2 ring-warning',
    goodsOn: 'to',
  },
  BUY: {
    icon: ShoppingCart,
    tone: 'text-primary-text bg-primary-subtle',
    active: 'ring-2 ring-primary',
    goodsOn: 'from',
  },
  SELL: {
    icon: HandCoins,
    tone: 'text-danger-text bg-danger-subtle',
    active: 'ring-2 ring-danger',
    goodsOn: 'to',
  },
};

type Row = Entry & { kind: Kind };

const goods = (row: Row) =>
  LOOK[row.kind].goodsOn === 'from'
    ? { currency: row.fromCurrency, amount: row.fromAmount }
    : { currency: row.toCurrency, amount: row.toAmount };

const counter = (row: Row) =>
  LOOK[row.kind].goodsOn === 'from'
    ? { currency: row.toCurrency, amount: row.toAmount }
    : { currency: row.fromCurrency, amount: row.fromAmount };

/** The price per unit of the goods, read off the amounts themselves. */
function priceOf(row: Row): string | null {
  const unit = Number(goods(row).amount);
  const other = Number(counter(row).amount);
  if (!unit || !other) return null;
  return (other / unit).toFixed(4).replace(/\.?0+$/, '');
}

export function DailyCountView() {
  const { t } = useLocale();
  const [day, setDay] = useState(() => dayInput(new Date()));
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('USDT');
  const [kind, setKind] = useState<Kind | null>(null);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    const from = new Date(year, month - 1, date);
    const to = new Date(year, month - 1, date, 23, 59, 59, 999);
    setLoading(true);
    try {
      const result = await api.get<{ groups: Group[] }>(
        `/api/my/daily-count${queryString({ from: from.toISOString(), to: to.toISOString() })}`,
      );
      setGroups(result.groups);
    } catch {
      setGroups(null);
    } finally {
      setLoading(false);
    }
  }, [day]);

  useEffect(() => {
    void load();
  }, [load]);

  const byKind = useMemo(
    () => new Map((groups ?? []).map((group) => [group.kind, group])),
    [groups],
  );
  const current = TABS.find((entry) => entry.tab === tab)!;

  // The tab's deals, newest first, narrowed by the chosen kind and the search.
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return current.kinds
      .filter((each) => kind === null || each === kind)
      .flatMap((each) =>
        (byKind.get(each)?.entries ?? []).map((entry): Row => ({ ...entry, kind: each })),
      )
      .filter(
        (row) =>
          !needle ||
          row.reference.toLowerCase().includes(needle) ||
          (row.customer ?? '').toLowerCase().includes(needle),
      )
      .sort((a, b) => b.at.localeCompare(a.at));
  }, [current, kind, byKind, search]);

  const chooseTab = (next: Tab) => {
    setTab(next);
    setKind(null);
  };

  const amounts = (list: Amount[], className?: string) =>
    list.length === 0 ? (
      <span className="text-content-tertiary">0</span>
    ) : (
      list.map((entry) => (
        <span key={entry.currency} className={cn('block', className)}>
          <Money value={entry.amount} currency={entry.currency} />
        </span>
      ))
    );

  return (
    <div className="space-y-4">
      {/* --- The day, and which list ------------------------------------------ */}
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 rounded-2xl bg-surface-sunken p-1">
          {TABS.map(({ tab: each, icon: Icon, kinds }) => {
            const total = kinds.reduce((sum, k) => sum + (byKind.get(k)?.count ?? 0), 0);
            return (
              <button
                key={each}
                type="button"
                onClick={() => chooseTab(each)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-colors sm:flex-none',
                  tab === each
                    ? 'bg-surface text-content shadow-sm'
                    : 'text-content-secondary hover:text-content',
                )}
              >
                <Icon className="size-4" />
                {t(`dailyCount.tab.${each}`)}
                <span className="rounded-full bg-surface-sunken px-2 py-px text-xs tabular-nums">
                  {total}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-center">
          <DayNavigator value={day} onChange={setDay} />
        </div>
      </div>

      {loading && !groups ? (
        <LoadingRows rows={4} />
      ) : !groups ? (
        <p className="py-6 text-center text-sm text-content-tertiary">
          {t('dailyCount.loadError')}
        </p>
      ) : (
        <>
          {/* --- The two kinds: totals, and a tap to show only that kind ------ */}
          <div className="grid gap-3 sm:grid-cols-2">
            {current.kinds.map((each) => {
              const look = LOOK[each];
              const Icon = look.icon;
              const group = byKind.get(each);
              const goodsTotal = look.goodsOn === 'from' ? group?.received : group?.paid;
              const counterTotal = look.goodsOn === 'from' ? group?.paid : group?.received;
              const chosen = kind === each;
              return (
                <button
                  key={each}
                  type="button"
                  onClick={() => setKind(chosen ? null : each)}
                  aria-pressed={chosen}
                  className={cn(
                    'rounded-2xl bg-surface p-4 text-start ring-1 ring-border-subtle transition-shadow hover:shadow-md',
                    chosen && look.active,
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-semibold text-content">
                      <span
                        className={cn(
                          'flex size-9 items-center justify-center rounded-xl',
                          look.tone,
                        )}
                      >
                        <Icon className="size-5" />
                      </span>
                      {t(`dailyCount.kind.${each}`)}
                    </span>
                    <Badge tone="neutral">
                      {t('dailyCount.operations', { count: group?.count ?? 0 })}
                    </Badge>
                  </div>
                  <div className="mt-3 flex items-end justify-between gap-3">
                    <div>
                      <p className="text-xs text-content-secondary">
                        {t(`dailyCount.goods.${each}`)}
                      </p>
                      <div className="text-xl font-bold tabular-nums">
                        {amounts(goodsTotal ?? [])}
                      </div>
                    </div>
                    <div className="text-end">
                      <p className="text-xs text-content-secondary">
                        {t(`dailyCount.counter.${each}`)}
                      </p>
                      <div className="text-sm font-semibold tabular-nums text-content-secondary">
                        {amounts(counterTotal ?? [])}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* --- The list ------------------------------------------------------ */}
          <section className="space-y-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-1 rounded-full bg-surface-sunken p-1">
                {[null, ...current.kinds].map((each) => (
                  <button
                    key={each ?? 'ALL'}
                    type="button"
                    onClick={() => setKind(each)}
                    className={cn(
                      'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                      kind === each
                        ? 'bg-surface text-content shadow-sm'
                        : 'text-content-secondary hover:text-content',
                    )}
                  >
                    {each ? t(`dailyCount.short.${each}`) : t('dailyCount.all')}
                  </button>
                ))}
              </div>
              <label className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-content-tertiary" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('dailyCount.search')}
                  className="w-full rounded-full bg-surface-sunken py-2 ps-9 pe-3 text-sm outline-none ring-1 ring-border-subtle focus:ring-primary"
                />
              </label>
            </div>

            {rows.length === 0 ? (
              <p className="py-8 text-center text-sm text-content-tertiary">
                {t('dailyCount.empty')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] border-collapse text-sm">
                  <thead>
                    <tr className="bg-surface-sunken text-xs text-content-secondary">
                      <th className="px-2 py-2 text-start font-medium">
                        {t('dailyCount.colTime')}
                      </th>
                      <th className="px-2 py-2 text-start font-medium">
                        {t('dailyCount.colKind')}
                      </th>
                      <th className="px-2 py-2 text-start font-medium">
                        {t('dailyCount.colCustomer')}
                      </th>
                      <th className="px-2 py-2 text-end font-medium">
                        {t('dailyCount.colAmount')}
                      </th>
                      <th className="px-2 py-2 text-end font-medium">{t('dailyCount.colPrice')}</th>
                      <th className="px-2 py-2 text-end font-medium">
                        {t('dailyCount.colCounter')}
                      </th>
                      <th className="w-10 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const look = LOOK[row.kind];
                      const Icon = look.icon;
                      const main = goods(row);
                      const other = counter(row);
                      const bank = BigInt(row.payoutBank) > 0n;
                      return (
                        <tr
                          key={row.id}
                          className={cn(
                            'border-t border-border-subtle align-middle',
                            row.reversed && 'bg-danger-subtle/20',
                          )}
                        >
                          <td className="px-2 py-2.5 tabular-nums ltr-content">
                            {new Date(row.at).toLocaleTimeString('en-GB', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td className="px-2 py-2.5">
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold',
                                look.tone,
                              )}
                            >
                              <Icon className="size-3.5" />
                              {t(`dailyCount.short.${row.kind}`)}
                            </span>
                          </td>
                          <td className="px-2 py-2.5">
                            <span className="block font-medium">
                              {row.customer ?? <span className="text-content-tertiary">—</span>}
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-1">
                              <span className="font-mono text-[11px] text-content-tertiary ltr-content">
                                {row.reference}
                              </span>
                              {row.reversed && (
                                <Badge tone="danger">{t('machine.deletedBadge')}</Badge>
                              )}
                              {!row.reversed && row.status === 'PENDING_TRANSFER' && (
                                <Badge tone="warning">{t('dailyCount.pending')}</Badge>
                              )}
                            </span>
                          </td>
                          <td
                            className={cn(
                              'px-2 py-2.5 text-end text-base font-bold tabular-nums',
                              row.reversed && 'text-content-tertiary line-through',
                            )}
                          >
                            <Money value={main.amount} currency={main.currency} />
                          </td>
                          <td className="px-2 py-2.5 text-end tabular-nums ltr-content">
                            {priceOf(row) ?? '—'}
                          </td>
                          <td
                            className={cn(
                              'px-2 py-2.5 text-end font-semibold tabular-nums text-content-secondary',
                              row.reversed && 'text-content-tertiary line-through',
                            )}
                          >
                            <Money value={other.amount} currency={other.currency} />
                            {bank && (
                              <span className="block text-[11px] font-normal text-content-tertiary">
                                {row.payoutChannel ?? t('dailyCount.byTransfer')}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2.5 text-end">
                            <a
                              href={`/print/receipt/${row.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={t('transactions.printReceipt')}
                              aria-label={t('transactions.printReceipt')}
                              className="inline-flex size-8 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content"
                            >
                              <Printer className="size-4" />
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
