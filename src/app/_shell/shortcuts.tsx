'use client';

import { useEffect, useRef } from 'react';
import { useLocale } from '@/i18n/provider';
import { Dialog } from '@/ui/overlay';
import type { TranslationKey } from '@/i18n/types';
import { visibleNavigation } from './navigation';

/**
 * Keyboard shortcuts.
 *
 * Tellers work at speed and largely without a mouse, so the common paths are
 * all reachable from the keyboard. Sequences follow the familiar `g` + letter
 * convention for navigation; single letters are reserved for actions.
 *
 * Shortcuts never fire while the user is typing in a field — the one exception
 * being Ctrl/Cmd+K, which must always open search.
 */

export interface ShortcutHandlers {
  onSearch: () => void;
  onHelp: () => void;
  onToggleTheme: () => void;
  onToggleLanguage: () => void;
  onNavigate: (href: string) => void;
  permissions: string[];
}

/**
 * The `g …` sequences, read from the sidebar itself.
 *
 * They used to be a list of their own here, pointing at screens that had since
 * been removed — so `g t` opened a page that no longer existed while the
 * sidebar went on advertising `g m`, `g u` and `g h`, which did nothing. One
 * source now: an item that shows a shortcut is the item it opens, and only for
 * someone who can see that item at all.
 */
function sequencesFor(permissions: string[]): { keys: string; href: string; labelKey: TranslationKey }[] {
  return visibleNavigation(permissions)
    .flatMap((section) => section.items)
    .flatMap((item) => {
      const match = item.shortcut?.match(/^g ([a-z])$/);
      return match ? [{ keys: match[1]!, href: item.href, labelKey: item.labelKey }] : [];
    });
}

/** Where `n` — a new transaction — goes: the exchange machine, for whoever has it. */
const NEW_TRANSACTION = { href: '/counter/machine', permission: 'exchange.machine.use' };

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    target.closest('[role="dialog"]') !== null
  );
}

export function useShortcuts(handlers: ShortcutHandlers) {
  // Tracks a pending `g` prefix. A ref, not state, so pressing `g` does not
  // re-render the entire shell.
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const granted = new Set(handlers.permissions);
    const sequences = sequencesFor(handlers.permissions);

    const clearPending = () => {
      pending.current = null;
      if (timer.current) clearTimeout(timer.current);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;

      // Search must work from anywhere, including inside a form.
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        handlers.onSearch();
        return;
      }

      if (meta || event.altKey || isTypingTarget(event.target)) return;

      const key = event.key.toLowerCase();

      // Second key of a `g …` navigation sequence.
      if (pending.current === 'g') {
        const match = sequences.find((sequence) => sequence.keys === key);
        clearPending();

        if (match) {
          event.preventDefault();
          handlers.onNavigate(match.href);
        }
        return;
      }

      switch (key) {
        case 'g':
          event.preventDefault();
          pending.current = 'g';
          // Abandon the sequence if the second key never arrives.
          timer.current = setTimeout(clearPending, 1500);
          break;

        case 'n':
          if (granted.has(NEW_TRANSACTION.permission)) {
            event.preventDefault();
            handlers.onNavigate(NEW_TRANSACTION.href);
          }
          break;

        case '?':
          event.preventDefault();
          handlers.onHelp();
          break;

        case '/':
          event.preventDefault();
          handlers.onSearch();
          break;

        default:
          if (event.shiftKey && key === 'd') {
            event.preventDefault();
            handlers.onToggleTheme();
          } else if (event.shiftKey && key === 'l') {
            event.preventDefault();
            handlers.onToggleLanguage();
          }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [handlers]);
}

// ---------------------------------------------------------------------------
// Help dialog
// ---------------------------------------------------------------------------

interface ShortcutRow {
  keys: string[];
  labelKey: TranslationKey;
}

/** The help, built from the same list the keys are — it cannot promise one that does not work. */
function groupsFor(permissions: string[]): { titleKey: TranslationKey; rows: ShortcutRow[] }[] {
  return [
    {
      titleKey: 'shortcuts.navigation',
      rows: sequencesFor(permissions).map((sequence) => ({
        keys: ['G', sequence.keys.toUpperCase()],
        labelKey: sequence.labelKey,
      })),
    },
    {
      titleKey: 'shortcuts.actions',
      rows: [
        ...(permissions.includes(NEW_TRANSACTION.permission)
          ? [{ keys: ['N'], labelKey: 'shortcuts.newTransaction' as TranslationKey }]
          : []),
        { keys: ['Ctrl', 'K'], labelKey: 'shortcuts.search' },
      ],
    },
    ...GENERAL,
  ];
}

const GENERAL: { titleKey: TranslationKey; rows: ShortcutRow[] }[] = [
  {
    titleKey: 'shortcuts.general',
    rows: [
      { keys: ['Shift', 'D'], labelKey: 'shortcuts.toggleTheme' },
      { keys: ['Shift', 'L'], labelKey: 'shortcuts.toggleLanguage' },
      { keys: ['Esc'], labelKey: 'shortcuts.close' },
      { keys: ['?'], labelKey: 'shortcuts.help' },
    ],
  },
];

export function ShortcutHelp({
  open,
  onClose,
  permissions,
}: {
  open: boolean;
  onClose: () => void;
  permissions: string[];
}) {
  const { t } = useLocale();

  return (
    <Dialog open={open} onClose={onClose} title={t('shortcuts.title')} size="md">
      <div className="grid gap-6 sm:grid-cols-2">
        {groupsFor(permissions).filter((group) => group.rows.length > 0).map((group) => (
          <section key={group.titleKey}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-content-tertiary">
              {t(group.titleKey)}
            </h3>
            <ul className="space-y-1.5">
              {group.rows.map((row) => (
                <li key={row.labelKey} className="flex items-center justify-between gap-4">
                  <span className="text-sm text-content-secondary">{t(row.labelKey)}</span>
                  <span className="flex shrink-0 gap-1">
                    {row.keys.map((key) => (
                      <kbd
                        key={key}
                        className="rounded border border-border-base bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-content"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
