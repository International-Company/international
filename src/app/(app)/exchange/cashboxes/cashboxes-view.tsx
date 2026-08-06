'use client';

import { useMemo, useState } from 'react';
import { useLocale } from '@/i18n/provider';
import { Badge, Card, CardHeader, EmptyState } from '@/ui/primitives';
import { Money } from '@/ui/display';
import { cn } from '@/ui/utils';

interface AccountRow {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  type: string;
  kind: string;
  currencyCode: string;
  balance: string;
  allowNegative: boolean;
}

interface TrialBalance {
  rows: {
    accountId: string;
    code: string;
    nameEn: string;
    nameAr: string;
    type: string;
    currencyCode: string;
    debit: string;
    credit: string;
    balance: string;
  }[];
  totals: Record<string, { debit: string; credit: string }>;
}

export function CashboxesView({
  accounts,
  trialBalance,
}: {
  accounts: AccountRow[];
  trialBalance: TrialBalance | null;
}) {
  const { t, ln } = useLocale();
  const [tab, setTab] = useState<'operational' | 'all' | 'trial'>('operational');

  // Operational view shows only what a teller physically handles; the full
  // chart of accounts includes clearing and income accounts that only matter
  // to an accountant.
  const operational = useMemo(
    () => accounts.filter((account) => ['CASH', 'BANK', 'CRYPTO'].includes(account.kind)),
    [accounts],
  );

  const visible = tab === 'operational' ? operational : accounts;

  const byCurrency = useMemo(() => {
    const groups = new Map<string, AccountRow[]>();
    for (const account of visible) {
      const list = groups.get(account.currencyCode) ?? [];
      list.push(account);
      groups.set(account.currencyCode, list);
    }
    return [...groups.entries()];
  }, [visible]);

  const tabs = [
    { id: 'operational' as const, label: t('nav.cashboxes') },
    { id: 'all' as const, label: t('common.all') },
    ...(trialBalance ? [{ id: 'trial' as const, label: t('accounts.trialBalance') }] : []),
  ];

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        className="inline-flex gap-1 rounded-[var(--radius-control)] border border-border-base bg-surface p-1"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={cn(
              'rounded px-3 py-1.5 text-sm transition-colors',
              tab === item.id
                ? 'bg-primary-subtle font-medium text-primary-text'
                : 'text-content-secondary hover:bg-surface-hover',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'trial' && trialBalance ? (
        <Card>
          <CardHeader title={t('accounts.trialBalance')} />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-base bg-surface-sunken">
                  <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                    {t('accounts.code')}
                  </th>
                  <th className="px-4 py-2 text-start text-xs font-medium text-content-secondary">
                    {t('accounts.accountName')}
                  </th>
                  <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                    {t('accounts.debit')}
                  </th>
                  <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                    {t('accounts.credit')}
                  </th>
                  <th className="px-4 py-2 text-end text-xs font-medium text-content-secondary">
                    {t('common.balance')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-base">
                {trialBalance.rows.map((row) => (
                  <tr key={row.accountId}>
                    <td className="px-4 py-2 font-mono text-xs text-content-secondary ltr-content">
                      {row.code}
                    </td>
                    <td className="px-4 py-2 text-sm text-content">{ln(row, 'name')}</td>
                    <td className="px-4 py-2 text-end text-sm">
                      <Money value={row.debit} />
                    </td>
                    <td className="px-4 py-2 text-end text-sm">
                      <Money value={row.credit} />
                    </td>
                    <td className="px-4 py-2 text-end text-sm font-medium">
                      <Money value={row.balance} currency={row.currencyCode} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-border-strong">
                {Object.entries(trialBalance.totals).map(([currency, totals]) => (
                  <tr key={currency} className="bg-surface-sunken">
                    <td colSpan={2} className="px-4 py-2 text-sm font-semibold text-content">
                      {t('common.total')} — {currency}
                    </td>
                    <td className="px-4 py-2 text-end text-sm font-semibold">
                      <Money value={totals.debit} />
                    </td>
                    <td className="px-4 py-2 text-end text-sm font-semibold">
                      <Money value={totals.credit} />
                    </td>
                    <td className="px-4 py-2 text-end text-xs">
                      {totals.debit === totals.credit ? (
                        <Badge tone="success">{t('businessDay.balanced')}</Badge>
                      ) : (
                        <Badge tone="danger">{t('dashboard.ledgerUnbalanced')}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tfoot>
            </table>
          </div>
        </Card>
      ) : byCurrency.length === 0 ? (
        <Card>
          <EmptyState title={t('common.noResults')} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {byCurrency.map(([currency, group]) => {
            const total = group.reduce((sum, account) => sum + BigInt(account.balance), 0n);

            return (
              <Card key={currency}>
                <CardHeader
                  title={currency}
                  actions={
                    tab === 'operational' && (
                      <Money
                        value={total}
                        currency={currency}
                        className="text-sm font-semibold"
                      />
                    )
                  }
                />
                <div className="divide-y divide-border-base">
                  {group.map((account) => (
                    <div
                      key={account.id}
                      className="flex items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-content">{ln(account, 'name')}</p>
                        <p className="flex items-center gap-1.5 font-mono text-[10px] text-content-tertiary ltr-content">
                          {account.code}
                          <span className="font-sans">
                            {t(`accounts.kindLabel.${account.kind}` as never)}
                          </span>
                        </p>
                      </div>
                      <Money
                        value={account.balance}
                        currency={currency}
                        className={cn(
                          'shrink-0 text-sm font-medium',
                          BigInt(account.balance) < 0n && 'text-danger-text',
                        )}
                      />
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
