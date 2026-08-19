'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Lock, Play } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { describeFailure } from '@/lib/failure';
import { useToast } from '@/ui/overlay';
import { cn } from '@/ui/utils';

/**
 * Starting the day, from the top of the sidebar.
 *
 * ## Why it is here and not only on the day screen
 *
 * Opening the counter is the first thing that happens every morning and the
 * one thing that must happen before anything else works. It lived three clicks
 * away, on a management screen nobody visits for any other reason, and until
 * somebody went there every tool in the building refused every trade with a
 * message about a day that is not open.
 *
 * So it sits under the brand, where the eye lands first, and it is gone the
 * moment it is done. A control that is only there when it is needed is the one
 * kind that never becomes furniture.
 *
 * ## Why a teller sees it too
 *
 * Not as a button — he cannot open the day and should not — but as a state. He
 * is the one who meets the refusal, and "the counter is closed" is the answer
 * to it. Showing him nothing would leave him to guess.
 */

interface DayState {
  open: boolean;
  date: string | null;
  canOpen: boolean;
}

export function DayChip({ collapsed }: { collapsed: boolean }) {
  const { t } = useLocale();
  const router = useRouter();
  const toast = useToast();

  const [state, setState] = useState<DayState | null>(null);
  const [opening, setOpening] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api.get<DayState>('/api/day/state'));
    } catch {
      // A strip that shouts about a failed poll would shout on every hiccup.
      setState(null);
    }
  }, []);

  useEffect(() => {
    void load();
    /*
     * Refreshed when the tab is looked at again rather than on a timer. The day
     * changes once, and a manager who opened it on his phone should not have to
     * reload the desk machine to see that — but nothing here is worth a poll.
     */
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const start = async () => {
    setOpening(true);
    try {
      await api.post('/api/manage/day', { action: 'open' });
      toast.success(t('day.started'), t('day.startedBody'));
      await load();
      // Every screen reads the day; the whole shell is stale the moment it opens.
      router.refresh();
    } catch (caught) {
      const failure = describeFailure(caught, t as never);
      toast.error(failure.title, failure.body);
      await load();
    } finally {
      setOpening(false);
    }
  };

  if (!state) return null;

  // --- Already working: a state, not a control -----------------------------
  if (state.open) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 border-b border-border-base px-4 py-2',
          collapsed && 'justify-center px-0',
        )}
        title={collapsed ? t('day.open') : undefined}
      >
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
          <span className="relative inline-flex size-2 rounded-full bg-success" />
        </span>
        {!collapsed && (
          <span className="truncate text-xs font-medium text-content-secondary">
            {t('day.open')}
          </span>
        )}
      </div>
    );
  }

  // --- Closed, and this person may open it ---------------------------------
  if (state.canOpen) {
    return (
      <div className={cn('border-b border-border-base p-2', collapsed && 'px-1')}>
        <button
          type="button"
          onClick={() => void start()}
          disabled={opening}
          title={collapsed ? t('day.start') : undefined}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)]',
            'bg-primary text-white shadow-[var(--shadow-sm)] transition-colors',
            'hover:bg-primary-hover disabled:opacity-60',
            collapsed ? 'h-10' : 'h-10 px-3',
          )}
        >
          {opening ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : (
            <Play className="size-4 shrink-0" />
          )}
          {!collapsed && <span className="text-sm font-semibold">{t('day.start')}</span>}
        </button>
      </div>
    );
  }

  // --- Closed, and they cannot open it: the answer to the refusal ----------
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b border-border-base px-4 py-2',
        collapsed && 'justify-center px-0',
      )}
      title={collapsed ? t('day.closed') : undefined}
    >
      <Lock className="size-3.5 shrink-0 text-warning-text" />
      {!collapsed && (
        <span className="truncate text-xs font-medium text-content-secondary">
          {t('day.closed')}
        </span>
      )}
    </div>
  );
}
