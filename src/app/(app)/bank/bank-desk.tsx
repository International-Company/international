'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowRight, MessagesSquare, Workflow } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { cn } from '@/ui/utils';
import { BankView } from './bank-view';
import { GroupFeed } from './group-feed';
import { TransferDetail } from './transfer-detail';
import { ForwardSheet, type Group } from './forward-panel';
import { MarkSentDialog } from './mark-sent-dialog';
import { TrackView } from './track-view';
import { keyOf, type Line } from './desk-types';

/** Both columns the same height: the page's, less its head. */
const TALL = 'h-[calc(100dvh-17rem)] min-h-[30rem] lg:h-[calc(100dvh-14rem)]';

/**
 * The bank desk, laid out as an inbox.
 *
 * The bank group's transfers at the side, two lines each; the one chosen in
 * full beside them, its action bar at the foot — a pinned group a tap away, or
 * the forward sheet for any other, and "sent". On a phone the list comes first
 * and a transfer opens over it. The other followed groups are a tab away.
 */
export function BankDesk() {
  const { t } = useLocale();
  const [mode, setMode] = useState<'work' | 'track' | 'watch'>('work');
  const [selected, setSelected] = useState<Line | null>(null);
  /** The chosen line's key: set before the list has the line, when a message was just added as a request. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** Bumped when one part changed something: the others ask again. */
  const [version, setVersion] = useState(0);
  const [sending, setSending] = useState<Line | null>(null);
  /** The forward sheet: open, with the groups a quick button ticked. */
  const [forwarding, setForwarding] = useState<{ preset?: Group[] } | null>(null);
  /** The pinned executing groups. */
  const [executors, setExecutors] = useState<Group[]>([]);

  useEffect(() => {
    api
      .get<{ groups: Group[] }>('/api/bank/groups/executors')
      .then((result) => setExecutors(result.groups))
      .catch(() => undefined);
  }, []);

  const changed = useCallback(() => setVersion((value) => value + 1), []);
  const choose = useCallback((line: Line | null) => {
    setSelected(line);
    setSelectedKey(line ? keyOf(line) : null);
  }, []);

  return (
    <div className="space-y-3">
      {/* --- The desk, or the followed groups as they were --- */}
      <div className="inline-flex max-w-full overflow-x-auto rounded-xl bg-surface-sunken p-1 [scrollbar-width:none]" role="tablist">
        {(
          [
            { key: 'work', icon: <Workflow className="size-4" />, label: t('bankDesk.workTab') },
            { key: 'track', icon: <Activity className="size-4" />, label: t('bankTrack.tab') },
            { key: 'watch', icon: <MessagesSquare className="size-4" />, label: t('bankDesk.watchTab') },
          ] as const
        ).map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={mode === option.key}
            onClick={() => setMode(option.key)}
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm font-semibold transition-all sm:gap-2 sm:px-4',
              mode === option.key
                ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                : 'text-content-tertiary hover:text-content-secondary',
            )}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>

      {mode === 'watch' ? (
        <GroupFeed />
      ) : mode === 'track' ? (
        // Opened from the watch: the transfer in full, in the desk.
        <TrackView
          onOpen={(line) => {
            choose(line);
            setMode('work');
          }}
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(20rem,25rem)_minmax(0,1fr)]">
          {/* The inbox: on a phone, out of the way while one is open. */}
          <BankView
            selectedKey={selectedKey}
            onSelect={choose}
            version={version}
            className={cn(TALL, selectedKey ? 'hidden lg:flex' : 'flex')}
          />

          {/* The one chosen. */}
          <div className={cn('min-w-0 flex-col gap-2', TALL, selectedKey ? 'flex' : 'hidden lg:flex')}>
            <button
              type="button"
              onClick={() => choose(null)}
              className="inline-flex h-9 w-fit shrink-0 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold text-content-secondary ring-1 ring-border-subtle hover:bg-surface-sunken lg:hidden"
            >
              <ArrowRight className="size-4 ltr:rotate-180" />
              {t('bankDesk.listTab')}
            </button>
            <TransferDetail
              line={selected}
              version={version}
              onSend={setSending}
              onChanged={changed}
              onAdded={(key) => {
                setSelected(null);
                setSelectedKey(key);
              }}
              executors={executors}
              onForward={(preset) => setForwarding({ preset })}
              className="min-h-0 flex-1"
            />
          </div>
        </div>
      )}

      <ForwardSheet
        open={forwarding !== null}
        messageId={selected?.messageId ?? null}
        preset={forwarding?.preset}
        executors={executors}
        onExecutors={setExecutors}
        onClose={() => setForwarding(null)}
        onForwarded={changed}
      />
      <MarkSentDialog line={sending} onClose={() => setSending(null)} onDone={changed} />
    </div>
  );
}
