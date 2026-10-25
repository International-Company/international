'use client';

import { useState, type ReactNode } from 'react';
import { useLocale } from '@/i18n/provider';
import { cn } from '@/ui/utils';
import { WalletOps } from './wallet-ops';

/**
 * The exchange counter's three services, one above the other's work: an
 * exchange, a cash-out from a customer's wallet, and a top-up into it. The
 * exchange is first and is where the screen opens, because it is most of what
 * the counter does.
 */

type Tab = 'EXCHANGE' | 'CASHOUT' | 'TOPUP';

export function MachineTabs({
  exchange,
  currencies,
  channels,
  permissions,
}: {
  /** The exchange machine itself, rendered by the page. */
  exchange: ReactNode;
  currencies: { code: string; nameAr: string; nameEn: string; decimals: number }[];
  channels: string[];
  permissions: string[];
}) {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>('EXCHANGE');

  const tabs: { key: Tab; label: string }[] = [
    { key: 'EXCHANGE', label: t('walletOps.tabExchange') },
    { key: 'CASHOUT', label: t('walletOps.tabCashout') },
    { key: 'TOPUP', label: t('walletOps.tabTopup') },
  ];

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        className="mx-auto flex w-full max-w-xl gap-1 rounded-2xl bg-surface-sunken p-1"
      >
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            // Wallet services need somewhere for the money to go.
            disabled={entry.key !== 'EXCHANGE' && channels.length === 0}
            onClick={() => setTab(entry.key)}
            className={cn(
              'h-10 flex-1 rounded-xl px-2 text-sm font-medium transition-colors disabled:opacity-40',
              tab === entry.key
                ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                : 'text-content-tertiary hover:text-content-secondary',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {/*
        The machine stays mounted while a wallet service is open, so a figure
        half-typed for the customer in front is still there on the way back.
      */}
      <div hidden={tab !== 'EXCHANGE'}>{exchange}</div>
      {tab !== 'EXCHANGE' && (
        <WalletOps
          key={tab}
          op={tab}
          currencies={currencies}
          channels={channels}
          permissions={permissions}
        />
      )}
    </div>
  );
}
