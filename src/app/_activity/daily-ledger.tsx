'use client';

import { useCallback, useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, queryString } from '@/lib/api-client';
import { Badge, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * A teller's days, one row each: what the machine exchanged, and what he owed
 * the bank when the day ended.
 *
 * ## Why the last column carries the earlier days too
 *
 * "How much do I owe the bank" is asked at the end of every day, and a
 * transfer left unsent yesterday is still owed today. So the figure is the
 * whole debt as of that evening, not the day's own transfers — the number the
 * teller and the person making the transfers actually reconcile against.
 *
 * ## Why each day can be sent
 *
 * The office closes its day on WhatsApp, not on this screen. One tap writes
 * the day out in plain lines, the same way every other message here is
 * written, and hands it to WhatsApp to send to whoever needs it.
 */

interface Amount {
  currency: string;
  amount: string;
}

interface LedgerDay {
  dayId: string;
  date: string;
  status: string;
  count: number;
  received: Amount[];
  paidCash: Amount[];
  paidBank: Amount[];
  owedAtEnd: Amount[];
}

/** The currency as the office writes it in a message. */
const SHORT_AR: Record<string, string> = { ILS: 'شيكل', USD: 'دولار', JOD: 'دينار', USDT: 'USDT' };

const decimalsOf = (currency: string) => (currency === 'JOD' ? 3 : 2);

/** A 1e8-scaled amount as a plain figure — whole amounts without ".00". */
function plain(scaled: string, currency: string): string {
  const value = BigInt(scaled || '0');
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const places = decimalsOf(currency);
  const unit = 10n ** BigInt(8 - places);
  const rounded = (abs + unit / 2n) / unit;
  const whole = rounded / 10n ** BigInt(places);
  const fraction = (rounded % 10n ** BigInt(places)).toString().padStart(places, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = /^0+$/.test(fraction) ? grouped : `${grouped}.${fraction}`;
  return negative ? `-${text}` : text;
}

export function DailyLedger({
  days = 14,
  tellerId,
  title,
  refreshKey,
}: {
  days?: number;
  /** Another teller's days, for a manager. Omitted: the signed-in person's own. */
  tellerId?: string;
  title?: string;
  /** Changes whenever something is recorded, so the running day follows at once. */
  refreshKey?: string | number | null;
}) {
  const { t, locale } = useLocale();
  const [rows, setRows] = useState<LedgerDay[] | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.get<{ days: LedgerDay[] }>(
        `/api/my/days${queryString({ days, tellerId })}`,
      );
      setRows(result.days);
    } catch {
      setRows((current) => current ?? []);
    }
  }, [days, tellerId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const unit = (currency: string) =>
    locale === 'ar' ? (SHORT_AR[currency] ?? currency) : currency;
  const lines = (amounts: Amount[]) =>
    amounts.length === 0
      ? [t('ledgerDays.nothing')]
      : amounts.map((entry) => `${plain(entry.amount, entry.currency)} ${unit(entry.currency)}`);

  /** The day, written out the way the office sends things. */
  const message = (day: LedgerDay) =>
    [
      t('ledgerDays.shareTitle', { date: day.date }),
      t('ledgerDays.shareCount', { count: day.count }),
      '',
      `${t('ledgerDays.received')}:`,
      ...lines(day.received),
      '',
      `${t('ledgerDays.paidCash')}:`,
      ...lines(day.paidCash),
      '',
      `${t('ledgerDays.paidBank')}:`,
      ...lines(day.paidBank),
      '',
      t('ledgerDays.shareOwed'),
      ...lines(day.owedAtEnd),
    ].join('\n');

  return (
    <Card>
      <CardHeader title={title ?? t('ledgerDays.title')} description={t('ledgerDays.hint')} />
      <CardBody className="p-0">
        {rows === null ? (
          <EmptyState title={t('common.loading')} />
        ) : rows.length === 0 ? (
          <EmptyState title={t('ledgerDays.none')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] border-collapse text-sm">
              <thead>
                <tr className="bg-surface-sunken text-xs text-content-secondary">
                  <th className="px-3 py-2 text-start font-medium">{t('ledgerDays.date')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('ledgerDays.ops')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('ledgerDays.received')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('ledgerDays.paidCash')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('ledgerDays.paidBank')}</th>
                  <th className="px-3 py-2 text-end font-medium">
                    {t('ledgerDays.owed')}
                    <span className="block text-[10px] font-normal text-content-tertiary">
                      {t('ledgerDays.owedHint')}
                    </span>
                  </th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((day) => {
                  const running = day.status === 'OPEN' || day.status === 'REOPENED';
                  const owes = day.owedAtEnd.some((entry) => BigInt(entry.amount) !== 0n);
                  return (
                    <tr
                      key={day.dayId}
                      className={cn(
                        'border-t border-border-subtle',
                        running && 'bg-primary-subtle/40',
                      )}
                    >
                      <td className="px-3 py-2 align-top">
                        <span className="font-medium tabular-nums ltr-content">{day.date}</span>
                        <Badge tone={running ? 'primary' : 'neutral'} className="ms-2">
                          {running ? t('ledgerDays.running') : t('ledgerDays.closed')}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-end align-top tabular-nums">{day.count}</td>
                      <AmountsCell amounts={day.received} />
                      <AmountsCell amounts={day.paidCash} />
                      <AmountsCell amounts={day.paidBank} />
                      <AmountsCell amounts={day.owedAtEnd} strong={owes} />
                      <td className="px-3 py-2 text-end align-top">
                        <a
                          href={`https://wa.me/?text=${encodeURIComponent(message(day))}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={t('ledgerDays.share')}
                          aria-label={t('ledgerDays.share')}
                          className="inline-flex size-9 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-success-text"
                        >
                          <MessageCircle className="size-4" />
                        </a>
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
  );
}

function AmountsCell({ amounts, strong }: { amounts: Amount[]; strong?: boolean }) {
  return (
    <td
      className={cn(
        'px-3 py-2 text-end align-top tabular-nums ltr-content',
        strong && 'font-bold text-warning-text',
      )}
    >
      {amounts.length === 0 ? (
        <span className="text-content-tertiary">—</span>
      ) : (
        amounts.map((entry) => (
          <span key={entry.currency} className="block">
            <Money
              value={entry.amount}
              currency={entry.currency}
              decimals={decimalsOf(entry.currency)}
            />
          </span>
        ))
      )}
    </td>
  );
}
