'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, Ban, MessagesSquare, Workflow, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api } from '@/lib/api-client';
import { cn } from '@/ui/utils';
import { BankTable } from './bank-table';
import { GroupFeed } from './group-feed';
import { TransferDetail } from './transfer-detail';
import { ForwardSheet, type Group } from './forward-panel';
import { MarkSentDialog } from './mark-sent-dialog';
import { TrackView } from './track-view';
import { CancelledView } from './cancelled-view';
import { keyOf, type Line } from './desk-types';

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
  const [mode, setMode] = useState<'work' | 'track' | 'watch' | 'cancelled'>('work');
  const [selected, setSelected] = useState<Line | null>(null);
  /** The chosen line's key: set before the list has the line, when a message was just added as a request. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** Bumped when one part changed something: the others ask again. */
  const [version, setVersion] = useState(0);
  const [sending, setSending] = useState<Line | null>(null);
  /** The transfer whose floating window was asked for from its row. */
  const [floatingLine, setFloatingLine] = useState<Line | null>(null);
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

  // The opened transfer closes with Escape, unless a dialog over it is open.
  useEffect(() => {
    if (!selected || forwarding || sending) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelected(null);
        setSelectedKey(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, forwarding, sending]);
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
            { key: 'cancelled', icon: <Ban className="size-4" />, label: t('bankCancelled.tab') },
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

      {mode === 'cancelled' ? (
        <CancelledView />
      ) : mode === 'watch' ? (
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
        <BankTable
          selectedKey={selectedKey}
          onOpen={choose}
          onSend={setSending}
          onFloat={setFloatingLine}
          onForward={(line, preset) => {
            choose(line);
            setForwarding({ preset });
          }}
          executors={executors}
          version={version}
          onChanged={changed}
        />
      )}

      {mode === 'work' && selected && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => choose(null)}
            className="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
          />
          <div className="relative flex h-full w-full max-w-xl flex-col bg-surface-sunken shadow-[var(--shadow-lg)]">
            <div className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-surface px-3 py-2">
              <span className="text-sm font-bold text-content">{t('bankTable.details')}</span>
              <button
                type="button"
                onClick={() => choose(null)}
                aria-label={t('common.close')}
                className="inline-flex size-8 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken hover:text-content"
              >
                <X className="size-4" />
              </button>
            </div>
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
              className="min-h-0 flex-1 rounded-none"
            />
          </div>
        </div>
      )}

      <ForwardSheet
        open={forwarding !== null}
        messageId={selected?.messageId ?? null}
        preset={forwarding?.preset}
        left={
          selected?.paid && selected.status === 'PENDING_TRANSFER'
            ? { amount: selected.amount, paid: selected.paid, currency: selected.currency }
            : null
        }
        executors={executors}
        onExecutors={setExecutors}
        onClose={() => setForwarding(null)}
        onForwarded={changed}
      />
      <MarkSentDialog line={sending} onClose={() => setSending(null)} onDone={changed} />
      {/* The row's floating window: the fields above the bank's site, and sent from there. */}
      <MarkSentDialog line={floatingLine} floatOnly onClose={() => setFloatingLine(null)} onDone={changed} />
    </div>
  );
}
