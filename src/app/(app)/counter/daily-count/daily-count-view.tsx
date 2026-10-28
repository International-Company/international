'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  HandCoins,
  Printer,
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
 * The day in four lists — USDT received, USDT sent, bought, sold — each with
 * its totals on top and its deals beneath, and a strip of the four counts
 * that jumps to each list.
 */

interface Amount {
  currency: string;
  amount: string;
}

type Kind = 'USDT_RECEIVE' | 'USDT_SEND' | 'BUY' | 'SELL';

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

/** How each list reads: its icon and colour, and which side is the "goods". */
const LOOK: Record<Kind, { icon: LucideIcon; tone: string; ring: string; goodsOn: 'from' | 'to' }> =
  {
    USDT_RECEIVE: {
      icon: ArrowDownToLine,
      tone: 'text-success-text bg-success-subtle',
      ring: 'ring-success/30',
      goodsOn: 'from',
    },
    USDT_SEND: {
      icon: ArrowUpFromLine,
      tone: 'text-warning-text bg-warning-subtle',
      ring: 'ring-warning/30',
      goodsOn: 'to',
    },
    BUY: {
      icon: ShoppingCart,
      tone: 'text-primary-text bg-primary-subtle',
      ring: 'ring-primary/30',
      goodsOn: 'from',
    },
    SELL: {
      icon: HandCoins,
      tone: 'text-danger-text bg-danger-subtle',
      ring: 'ring-danger/30',
      goodsOn: 'to',
    },
  };

/** The price per unit of the goods, read off the amounts themselves. */
function priceOf(entry: Entry, goodsOn: 'from' | 'to'): string | null {
  const goods = Number(goodsOn === 'from' ? entry.fromAmount : entry.toAmount);
  const other = Number(goodsOn === 'from' ? entry.toAmount : entry.fromAmount);
  if (!goods || !other) return null;
  return (other / goods).toFixed(4).replace(/\.?0+$/, '');
}

export function DailyCountView() {
  const { t } = useLocale();
  const [day, setDay] = useState(() => dayInput(new Date()));
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [loading, setLoading] = useState(true);

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

  const amounts = (list: Amount[]) =>
    list.length === 0 ? (
      <span className="text-content-tertiary">—</span>
    ) : (
      list.map((entry) => (
        <span key={entry.currency} className="block">
          <Money value={entry.amount} currency={entry.currency} />
        </span>
      ))
    );

  return (
    <div className="space-y-4">
      <div className="flex justify-center sm:justify-end">
        <DayNavigator value={day} onChange={setDay} />
      </div>

      {loading && !groups ? (
        <LoadingRows rows={4} />
      ) : !groups ? (
        <p className="py-6 text-center text-sm text-content-tertiary">
          {t('dailyCount.loadError')}
        </p>
      ) : (
        <>
          {/* --- The four counts, each a jump to its list --------------------- */}
          <nav className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {groups.map((group) => {
              const look = LOOK[group.kind];
              const Icon = look.icon;
              return (
                <a
                  key={group.kind}
                  href={`#${group.kind}`}
                  className="flex items-center gap-3 rounded-2xl bg-surface p-3 ring-1 ring-border-subtle transition-shadow hover:shadow-md"
                >
                  <span
                    className={cn('flex size-10 items-center justify-center rounded-xl', look.tone)}
                  >
                    <Icon className="size-5" />
                  </span>
                  <span>
                    <span className="block text-xs text-content-secondary">
                      {t(`dailyCount.kind.${group.kind}`)}
                    </span>
                    <span className="text-xl font-bold tabular-nums">{group.count}</span>
                  </span>
                </a>
              );
            })}
          </nav>

          {/* --- Each kind on its own ------------------------------------------ */}
          {groups.map((group) => {
            const look = LOOK[group.kind];
            const Icon = look.icon;
            return (
              <section
                key={group.kind}
                id={group.kind}
                className="scroll-mt-20 space-y-3 rounded-2xl bg-surface p-4 ring-1 ring-border-subtle"
              >
                <header className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-base font-semibold text-content">
                    <span
                      className={cn(
                        'flex size-8 items-center justify-center rounded-lg',
                        look.tone,
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    {t(`dailyCount.kind.${group.kind}`)}
                  </h2>
                  <Badge tone="neutral">{t('dailyCount.operations', { count: group.count })}</Badge>
                </header>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className={cn('rounded-xl bg-surface-sunken p-3 ring-1', look.ring)}>
                    <p className="text-xs font-medium text-content-secondary">
                      {t(`dailyCount.received.${group.kind}`)}
                    </p>
                    <div className="mt-1 text-lg font-bold tabular-nums">
                      {amounts(group.received)}
                    </div>
                  </div>
                  <div className={cn('rounded-xl bg-surface-sunken p-3 ring-1', look.ring)}>
                    <p className="text-xs font-medium text-content-secondary">
                      {t(`dailyCount.paid.${group.kind}`)}
                    </p>
                    <div className="mt-1 text-lg font-bold tabular-nums">{amounts(group.paid)}</div>
                  </div>
                </div>

                {group.entries.length === 0 ? (
                  <p className="py-4 text-center text-sm text-content-tertiary">
                    {t('dailyCount.empty')}
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[40rem] border-collapse text-sm">
                      <thead>
                        <tr className="bg-surface-sunken text-xs text-content-secondary">
                          <th className="px-2 py-2 text-start font-medium">
                            {t('dailyCount.colTime')}
                          </th>
                          <th className="px-2 py-2 text-start font-medium">
                            {t('dailyCount.colCustomer')}
                          </th>
                          <th className="px-2 py-2 text-end font-medium">
                            {t(`dailyCount.received.${group.kind}`)}
                          </th>
                          <th className="px-2 py-2 text-end font-medium">
                            {t('dailyCount.colPrice')}
                          </th>
                          <th className="px-2 py-2 text-end font-medium">
                            {t(`dailyCount.paid.${group.kind}`)}
                          </th>
                          <th className="w-10 px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {group.entries.map((entry) => {
                          const bank = BigInt(entry.payoutBank) > 0n;
                          return (
                            <tr
                              key={entry.id}
                              className={cn(
                                'border-t border-border-subtle align-top',
                                entry.reversed && 'bg-danger-subtle/20',
                              )}
                            >
                              <td className="px-2 py-2 tabular-nums ltr-content">
                                {new Date(entry.at).toLocaleTimeString('en-GB', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </td>
                              <td className="px-2 py-2">
                                <span className="block">
                                  {entry.customer ?? (
                                    <span className="text-content-tertiary">—</span>
                                  )}
                                </span>
                                <span className="mt-0.5 flex flex-wrap items-center gap-1">
                                  <span className="font-mono text-[11px] text-content-tertiary ltr-content">
                                    {entry.reference}
                                  </span>
                                  {entry.reversed && (
                                    <Badge tone="danger">{t('machine.deletedBadge')}</Badge>
                                  )}
                                  {!entry.reversed && entry.status === 'PENDING_TRANSFER' && (
                                    <Badge tone="warning">{t('dailyCount.pending')}</Badge>
                                  )}
                                </span>
                              </td>
                              <td
                                className={cn(
                                  'px-2 py-2 text-end font-semibold tabular-nums',
                                  entry.reversed && 'text-content-tertiary line-through',
                                )}
                              >
                                <Money value={entry.fromAmount} currency={entry.fromCurrency} />
                              </td>
                              <td className="px-2 py-2 text-end tabular-nums ltr-content">
                                {priceOf(entry, look.goodsOn) ?? '—'}
                              </td>
                              <td
                                className={cn(
                                  'px-2 py-2 text-end font-semibold tabular-nums',
                                  entry.reversed && 'text-content-tertiary line-through',
                                )}
                              >
                                <Money value={entry.toAmount} currency={entry.toCurrency} />
                                {bank && (
                                  <span className="block text-[11px] font-normal text-content-tertiary">
                                    {entry.payoutChannel ?? t('dailyCount.byTransfer')}
                                  </span>
                                )}
                              </td>
                              <td className="px-2 py-2 text-end">
                                <a
                                  href={`/print/receipt/${entry.id}`}
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
            );
          })}
        </>
      )}
    </div>
  );
}
