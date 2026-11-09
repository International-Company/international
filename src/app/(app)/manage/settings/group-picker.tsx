'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { groupsMatching } from '@/modules/whatsapp/group-routes';

interface PickerGroup {
  id: string;
  name: string;
}

/** A list of WhatsApp groups to find by typing, for a number that is in a great many. */
export function GroupPicker<T extends PickerGroup>({
  groups,
  value,
  currentName,
  unsetLabel,
  ariaLabel,
  disabled,
  labelOf,
  onChange,
}: {
  groups: T[];
  value: string;
  /** Said for a group set earlier that is no longer in the list. */
  currentName?: string;
  /** Offered as a choice when picking nothing is allowed. */
  unsetLabel?: string;
  ariaLabel: string;
  disabled?: boolean;
  labelOf: (group: T) => string;
  onChange: (id: string) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const current = groups.find((group) => group.id === value);
  const shown = groupsMatching(groups, query);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  const row = (id: string, label: string) => (
    <li key={id || 'unset'}>
      <button
        type="button"
        onClick={() => pick(id)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm text-content hover:bg-surface-sunken"
      >
        <span className="min-w-0 truncate">{label}</span>
        {id === value && <Check className="size-4 shrink-0 text-primary-text" />}
      </button>
    </li>
  );

  return (
    <div ref={box} className="relative min-w-0 flex-1 sm:max-w-xs">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-xl bg-surface-sunken px-3 text-sm font-medium text-content outline-none ring-1 ring-border-subtle focus:ring-primary disabled:opacity-60"
      >
        <span className="min-w-0 truncate">
          {current ? labelOf(current) : value ? (currentName ?? value) : (unsetLabel ?? '')}
        </span>
        <ChevronDown className="size-4 shrink-0 text-content-tertiary" />
      </button>

      {open && (
        <div className="absolute end-0 z-30 mt-1 w-full min-w-64 overflow-hidden rounded-xl bg-surface shadow-[var(--shadow-lg)] ring-1 ring-border-base">
          <div className="flex items-center gap-2 border-b border-border-subtle px-3">
            <Search className="size-4 shrink-0 text-content-tertiary" />
            <input
              ref={search}
              type="text"
              autoComplete="off"
              data-zoom-safe=""
              aria-label={t('whatsapp.searchGroups')}
              placeholder={t('whatsapp.searchGroups')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (shown[0]) pick(shown[0].id);
                }
              }}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm text-content outline-none placeholder:text-content-tertiary"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {unsetLabel !== undefined && !query.trim() && row('', unsetLabel)}
            {shown.map((group) => row(group.id, labelOf(group)))}
            {shown.length === 0 && (
              <li className="px-3 py-3 text-center text-sm text-content-tertiary">
                {t('whatsapp.noGroupFound')}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
