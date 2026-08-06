'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { CornerDownLeft, Loader2, Search } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { cn } from '@/ui/utils';
import { NAV_ICONS } from './icons';
import { visibleNavigation, type IconName, type NavFeatures } from './navigation';

/**
 * Global search — the fastest route to any record in the system.
 *
 * Pages are matched locally and appear instantly; records are fetched from the
 * server with a debounce. Results are grouped, and the whole list is navigable
 * with the arrow keys so a keyboard-first operator never has to reach for the
 * mouse mid-transaction.
 */

interface SearchResult {
  id: string;
  group: 'transactions' | 'customers' | 'wallets' | 'accounts' | 'pages';
  title: string;
  subtitle?: string;
  href: string;
  icon: IconName;
}

const GROUP_ORDER: SearchResult['group'][] = [
  'pages',
  'transactions',
  'customers',
  'wallets',
  'accounts',
];

export function CommandPalette({
  open,
  onClose,
  permissions,
  features,
}: {
  open: boolean;
  onClose: () => void;
  permissions: string[];
  features: NavFeatures;
}) {
  const { t, locale } = useLocale();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Local page matches — no round trip needed for navigation.
  const pageResults = useMemo<SearchResult[]>(() => {
    const sections = visibleNavigation(permissions, features);
    const term = query.trim().toLowerCase();

    return sections
      .flatMap((section) => section.items)
      .map((item) => ({
        id: item.href,
        group: 'pages' as const,
        title: t(item.labelKey),
        href: item.href,
        icon: item.icon,
      }))
      .filter((result) => !term || result.title.toLowerCase().includes(term))
      .slice(0, term ? 5 : 8);
  }, [permissions, features, query, t]);

  const results = useMemo(() => {
    const combined = [...pageResults, ...remote];
    return GROUP_ORDER.flatMap((group) => combined.filter((result) => result.group === group));
  }, [pageResults, remote]);

  // Reset whenever the palette is reopened.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setRemote([]);
    setActiveIndex(0);
    // Focus after the portal has painted.
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Debounced record search.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setRemote([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();

    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('search failed');

        const body = (await response.json()) as { data: SearchResult[] };
        setRemote(body.data ?? []);
        setActiveIndex(0);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') setRemote([]);
      } finally {
        setLoading(false);
      }
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const select = useCallback(
    (result: SearchResult) => {
      onClose();
      router.push(result.href);
    },
    [onClose, router],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const selected = results[activeIndex];
      if (selected) select(selected);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!mounted || !open) return null;

  let renderedIndex = -1;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[10vh]">
      <div className="fixed inset-0 bg-[var(--overlay)]" onClick={onClose} aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('search.placeholder')}
        className="relative z-10 w-full max-w-xl animate-in overflow-hidden rounded-[var(--radius-card)] border border-border-base bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-center gap-3 border-b border-border-base px-4">
          <Search className="size-4 shrink-0 text-content-tertiary" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('search.placeholder')}
            className="h-12 flex-1 bg-transparent text-sm text-content outline-none placeholder:text-content-tertiary"
            aria-autocomplete="list"
            aria-controls="command-results"
          />
          {loading && <Loader2 className="size-4 shrink-0 animate-spin text-content-tertiary" />}
          <kbd className="hidden shrink-0 rounded border border-border-base bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content-tertiary sm:inline">
            Esc
          </kbd>
        </div>

        <div ref={listRef} id="command-results" role="listbox" className="max-h-80 overflow-y-auto py-2">
          {results.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-content-secondary">
              {query.trim().length < 2 ? t('search.hint') : t('search.noResults', { query })}
            </p>
          )}

          {GROUP_ORDER.map((group) => {
            const groupResults = results.filter((result) => result.group === group);
            if (groupResults.length === 0) return null;

            return (
              <div key={group} className="mb-1">
                <p className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-content-tertiary">
                  {t(`search.groups.${group}`)}
                </p>
                {groupResults.map((result) => {
                  renderedIndex += 1;
                  const index = renderedIndex;
                  const Icon = NAV_ICONS[result.icon];
                  const active = index === activeIndex;

                  return (
                    <button
                      key={`${result.group}-${result.id}`}
                      type="button"
                      data-index={index}
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => select(result)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2 text-start transition-colors',
                        active ? 'bg-primary-subtle' : 'hover:bg-surface-hover',
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-4 shrink-0',
                          active ? 'text-primary-text' : 'text-content-tertiary',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-content">{result.title}</span>
                        {result.subtitle && (
                          <span className="block truncate text-xs text-content-tertiary">
                            {result.subtitle}
                          </span>
                        )}
                      </span>
                      {active && (
                        <CornerDownLeft className="size-3.5 shrink-0 text-content-tertiary" />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-border-base bg-surface-sunken px-4 py-2 text-[10px] text-content-tertiary">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-base bg-surface px-1 font-mono">↑↓</kbd>
            {locale === 'ar' ? 'تنقل' : 'navigate'}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-base bg-surface px-1 font-mono">↵</kbd>
            {locale === 'ar' ? 'فتح' : 'open'}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
