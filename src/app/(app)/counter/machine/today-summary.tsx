'use client';

import { useCallback, useEffect, useState } from 'react';
import { Banknote, Landmark } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * Two small windows under the machine: what I have exchanged today, and what of
 * it the office still owes by transfer.
 *
 * ## Why under the card and not above it
 *
 * The card is the tool and the customer is in front of it; anything above it
 * pushes the amount the customer reads further down a phone screen. These are
 * glanced at between customers, so they sit with the recent work, where the
 * eye already goes once a trade is done.
 *
 * ## Why the transfers are split by channel
 *
 * "How much do I still owe through PalPay" is the question the teller is asked
 * at the end of the day, by the person who has to send it. A single total would
 * make him add it up again by hand from the receipts.
 */

interface Amount {
  currency: string;
  amount: string;
}

interface ChannelTotal {
  channel: string;
  currency: string;
  pending: string;
  pendingCount: number;
  sent: string;
  sentCount: number;
}

interface Today {
  dayOpen: boolean;
  count: number;
  received: Amount[];
  paidCash: Amount[];
  paidBank: Amount[];
  bank: ChannelTotal[];
}

/** How often it refreshes on its own, besides after every trade. */
const REFRESH_MS = 60_000;

export function TodaySummary({
  refreshKey,
  decimalsOf,
}: {
  /** Changes whenever a trade is recorded, so the totals follow it at once. */
  refreshKey: string | null;
  decimalsOf: (currency: string) => number;
}) {
  const { t } = useLocale();
  const [today, setToday] = useState<Today | null>(null);

  const load = useCallback(async () => {
    try {
      setToday(await api.get<Today>('/api/exchange/machine/today'));
    } catch {
      // A summary that cannot load is left as it was; the tool still works.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (!today) return null;

  if (!today.dayOpen) {
    return (
      <p className="rounded-2xl bg-surface px-4 py-3 text-xs text-content-tertiary ring-1 ring-border-subtle">
        {t('machine.today.dayClosed')}
      </p>
    );
  }

  const pendingByCurrency = new Map<string, bigint>();
  const sentByCurrency = new Map<string, bigint>();
  for (const entry of today.bank) {
    pendingByCurrency.set(
      entry.currency,
      (pendingByCurrency.get(entry.currency) ?? 0n) + BigInt(entry.pending),
    );
    sentByCurrency.set(
      entry.currency,
      (sentByCurrency.get(entry.currency) ?? 0n) + BigInt(entry.sent),
    );
  }
  const pending = [...pendingByCurrency].filter(([, amount]) => amount > 0n);
  const sent = [...sentByCurrency].filter(([, amount]) => amount > 0n);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {/* --- What I exchanged ---------------------------------------------- */}
      <section className="rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
        <header className="mb-3 flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-content">
            <Banknote className="size-4 text-primary-text" />
            {t('machine.today.exchanged')}
          </h3>
          <span className="rounded-full bg-surface-sunken px-2 py-0.5 text-xs tabular-nums text-content-secondary">
            {t('machine.today.operations', { count: today.count })}
          </span>
        </header>

        {today.count === 0 ? (
          <p className="text-sm text-content-tertiary">{t('machine.today.nothingYet')}</p>
        ) : (
          <dl className="space-y-2 text-sm">
            <Line
              label={t('machine.today.received')}
              amounts={today.received}
              decimalsOf={decimalsOf}
            />
            <Line
              label={t('machine.today.paidCash')}
              amounts={today.paidCash}
              decimalsOf={decimalsOf}
            />
            <Line
              label={t('machine.today.paidBank')}
              amounts={today.paidBank}
              decimalsOf={decimalsOf}
            />
          </dl>
        )}
      </section>

      {/* --- What is owed by transfer -------------------------------------- */}
      <section className="rounded-2xl bg-surface p-4 ring-1 ring-border-subtle">
        <header className="mb-3 flex items-center gap-2">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-content">
            <Landmark className="size-4 text-primary-text" />
            {t('machine.today.bankDue')}
          </h3>
        </header>

        {today.bank.length === 0 ? (
          <p className="text-sm text-content-tertiary">{t('machine.today.noTransfers')}</p>
        ) : (
          <div className="space-y-3">
            {/* The figure that is still somebody's job: large, and amber. */}
            <div className="rounded-xl bg-warning-subtle px-3 py-2">
              <p className="text-xs text-warning-text">{t('machine.today.pending')}</p>
              {pending.length === 0 ? (
                <p className="mt-0.5 text-lg font-bold tabular-nums text-content ltr-content">0</p>
              ) : (
                pending.map(([currency, amount]) => (
                  <p
                    key={currency}
                    className="mt-0.5 text-lg font-bold tabular-nums text-content ltr-content"
                  >
                    <Money value={amount} currency={currency} decimals={decimalsOf(currency)} />
                  </p>
                ))
              )}
            </div>

            {sent.length > 0 && (
              <div className="flex items-start justify-between gap-3 text-sm">
                <span className="text-content-secondary">{t('machine.today.sent')}</span>
                <span className="text-end tabular-nums ltr-content">
                  {sent.map(([currency, amount]) => (
                    <span key={currency} className="block">
                      <Money value={amount} currency={currency} decimals={decimalsOf(currency)} />
                    </span>
                  ))}
                </span>
              </div>
            )}

            <div>
              <p className="mb-1 text-xs text-content-tertiary">{t('machine.today.byChannel')}</p>
              <ul className="divide-y divide-border-subtle text-sm">
                {today.bank.map((entry) => {
                  const owed = BigInt(entry.pending);
                  return (
                    <li
                      key={`${entry.channel}:${entry.currency}`}
                      className="flex items-center justify-between gap-3 py-1.5"
                    >
                      <span className="min-w-0 truncate text-content">{entry.channel}</span>
                      <span className="flex shrink-0 items-center gap-2 tabular-nums ltr-content">
                        <span
                          className={cn(
                            owed > 0n ? 'font-semibold text-warning-text' : 'text-content-tertiary',
                          )}
                        >
                          <Money
                            value={owed}
                            currency={entry.currency}
                            decimals={decimalsOf(entry.currency)}
                          />
                        </span>
                        {BigInt(entry.sent) > 0n && (
                          <span className="text-xs text-content-tertiary">
                            +<Money value={entry.sent} decimals={decimalsOf(entry.currency)} /> ✓
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** One label against one or more currencies. */
function Line({
  label,
  amounts,
  decimalsOf,
}: {
  label: string;
  amounts: Amount[];
  decimalsOf: (currency: string) => number;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-content-secondary">{label}</dt>
      <dd className="text-end font-medium tabular-nums ltr-content">
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
      </dd>
    </div>
  );
}
