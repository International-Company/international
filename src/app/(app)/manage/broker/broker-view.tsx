'use client';

import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Landmark } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { Alert, Badge, Card, CardBody, CardHeader, EmptyState } from '@/ui/primitives';
import { DateText, Money } from '@/ui/display';
import { cn } from '@/ui/utils';

/**
 * The broker's side of the books, as far as the branch can see it.
 *
 * Deliberately not presented as balances per account. The branch holds one
 * claim, on the broker; the accounts are where instructions were sent. Showing
 * a per-account balance would invent a second thing claiming to know how much
 * money exists, and the day it disagreed with the real balance nobody would
 * know which to believe.
 */

interface Movement {
  id: string;
  direction: string;
  amount: string;
  balanceAfter: string;
  reason: string;
  account: string | null;
  note: string | null;
  createdAt: string;
  transaction: { id: string; reference: string; status: string } | null;
  createdBy: { fullNameEn: string; fullNameAr: string };
}

interface Activity {
  currency: string;
  decimals: number;
  balance: string;
  accounts: { account: string; out: string; in: string; net: string; count: number }[];
  movements: Movement[];
}

export function BrokerView({
  activity,
  accounts,
  since,
}: {
  activity: Activity[];
  accounts: string[];
  since: string;
}) {
  const { t, ln } = useLocale();
  const [account, setAccount] = useState<string | null>(null);

  if (activity.length === 0) {
    return (
      <Card>
        <EmptyState icon={<Landmark />} title={t('broker.none')} description={t('broker.noneHint')} />
      </Card>
    );
  }

  /*
   * An account the manager has since removed from the list can still appear in
   * the history — the instruction went through it, and hiding that would make
   * a past transfer unaccountable. Retired names are shown and marked.
   */
  const known = new Set(accounts);
  const seen = new Set(activity.flatMap((entry) => entry.accounts.map((row) => row.account)));
  const retired = [...seen].filter((name) => name !== '—' && !known.has(name));

  return (
    <div className="space-y-4">
      <Alert tone="neutral">
        {t('broker.explain')} <DateText value={since} />
      </Alert>

      {retired.length > 0 && (
        <Alert tone="warning" title={t('broker.retiredTitle')}>
          {t('broker.retiredBody', { accounts: retired.join('، ') })}
        </Alert>
      )}

      {/* --- Filter by account, since that is how a statement arrives ----- */}
      {accounts.length > 1 && (
        <div dir="rtl" className="flex flex-wrap gap-2">
          <FilterChip active={account === null} onClick={() => setAccount(null)}>
            {t('common.all')}
          </FilterChip>
          {[...known, ...retired].map((name) => (
            <FilterChip key={name} active={account === name} onClick={() => setAccount(name)}>
              {name}
            </FilterChip>
          ))}
        </div>
      )}

      {activity.map((entry) => {
        const rows = entry.accounts.filter((row) => !account || row.account === account);
        const movements = entry.movements.filter((row) => !account || (row.account ?? '—') === account);

        return (
          <Card key={entry.currency}>
            <CardHeader
              title={`${t('broker.through')} — ${entry.currency}`}
              description={t('broker.compare')}
              actions={
                <span className="flex items-center gap-2 text-sm">
                  <span className="text-content-secondary">{t('broker.claim')}</span>
                  <span className="font-semibold tabular-nums text-content ltr-content">
                    <Money value={entry.balance} decimals={entry.decimals} />
                  </span>
                </span>
              }
            />

            <CardBody className="space-y-3">
              {rows.length === 0 ? (
                <p className="text-sm text-content-secondary">{t('broker.nothing')}</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border-base">
                  <table className="w-full min-w-[30rem] border-collapse">
                    <thead>
                      <tr className="bg-surface-sunken text-xs text-content-secondary">
                        <th className="px-3 py-2 text-start font-medium">{t('broker.account')}</th>
                        <th className="px-3 py-2 text-end font-medium">{t('broker.sent')}</th>
                        <th className="px-3 py-2 text-end font-medium">{t('broker.returned')}</th>
                        <th className="px-3 py-2 text-end font-medium">{t('broker.net')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.account} className="border-t border-border-subtle text-sm">
                          <td className="px-3 py-2">
                            {row.account === '—' ? (
                              <span className="text-content-tertiary">{t('broker.unnamed')}</span>
                            ) : (
                              row.account
                            )}
                            <span className="ms-2 text-xs text-content-tertiary">
                              {t('broker.count', { count: String(row.count) })}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-end tabular-nums ltr-content">
                            <Money value={row.out} decimals={entry.decimals} />
                          </td>
                          <td className="px-3 py-2 text-end tabular-nums ltr-content">
                            <Money value={row.in} decimals={entry.decimals} />
                          </td>
                          <td className="px-3 py-2 text-end font-semibold tabular-nums ltr-content">
                            <Money value={row.net} decimals={entry.decimals} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* The lines behind the totals, for when they disagree. */}
              {movements.length > 0 && (
                <ul className="divide-y divide-border-subtle rounded-lg border border-border-base">
                  {movements.slice(0, 40).map((movement) => {
                    const outgoing = movement.direction === 'OUT';
                    return (
                      <li key={movement.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                        <span
                          className={cn(
                            'flex size-6 shrink-0 items-center justify-center rounded-full',
                            outgoing ? 'bg-danger-subtle' : 'bg-success-subtle',
                          )}
                        >
                          {outgoing ? (
                            <ArrowUpRight className="size-3 text-danger-text" />
                          ) : (
                            <ArrowDownLeft className="size-3 text-success-text" />
                          )}
                        </span>

                        <span className="text-sm tabular-nums text-content ltr-content">
                          <Money value={movement.amount} decimals={entry.decimals} />
                        </span>

                        <Badge tone="neutral">{movement.account ?? t('broker.unnamed')}</Badge>

                        {movement.transaction && (
                          <span className="font-mono text-xs text-content-tertiary ltr-content">
                            {movement.transaction.reference}
                          </span>
                        )}

                        <span className="ms-auto text-xs text-content-tertiary">
                          <DateText value={movement.createdAt} withTime />
                        </span>
                        <span className="text-xs text-content-tertiary">
                          {ln(movement.createdBy, 'fullName')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'h-10 rounded-full px-4 text-sm font-medium transition-colors sm:h-9',
        active
          ? 'bg-primary text-white'
          : 'bg-surface-sunken text-content-secondary hover:text-content',
      )}
    >
      {children}
    </button>
  );
}
