'use client';

import { useState } from 'react';
import { useLocale } from '@/i18n/provider';
import { cn } from '@/ui/utils';
import { BankView } from './bank-view';
import { GroupFeed } from './group-feed';

/**
 * The desk laid out for the work: the transfers to send in a narrow column at
 * the side, the groups they travel through in the main space. On a phone there
 * is room for one at a time, so two tabs choose.
 */
export function BankDesk() {
  const { t } = useLocale();
  const [tab, setTab] = useState<'transfers' | 'groups'>('transfers');
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1 rounded-full bg-surface-sunken p-1 xl:hidden">
        {(['transfers', 'groups'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={tab === option}
            onClick={() => setTab(option)}
            className={cn(
              'h-10 rounded-full text-sm font-semibold transition-colors',
              tab === option
                ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                : 'text-content-tertiary',
            )}
          >
            {option === 'transfers' ? t('bank.waiting') : t('bankFeed.choose')}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(22rem,28rem)_minmax(0,1fr)]">
        <div className={cn(tab === 'transfers' ? 'block' : 'hidden', 'min-w-0 xl:block')}>
          <BankView />
        </div>
        <div className={cn(tab === 'groups' ? 'block' : 'hidden', 'min-w-0 xl:block')}>
          <GroupFeed />
        </div>
      </div>
    </div>
  );
}
