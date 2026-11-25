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
  /** What is left of a transfer, being sent: with its receipt, or settled by hand. */
  const [executing, setExecuting] = useState<Line | null>(null);
  /** The floating window opened for what is left of one. */
  const [floatingLeft, setFloatingLeft] = useState<Line | null>(null);
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

  /*
   * Live: the desk's pulse asked every two seconds while the page is in view.
   * Anything changed — sent, a receipt kept or read, a new transfer, a forward
   * — and every part of the desk reads again at once.
   */
  useEffect(() => {
    let last: string | null = null;
    let asking = false;
    const ask = async () => {
      if (asking || document.hidden) return;
      asking = true;
      try {
        const { pulse } = await api.get<{ pulse: string }>('/api/bank/pulse');
        if (last !== null && pulse !== last) changed();
        last = pulse;
      } catch {
        // The next beat asks again.
      } finally {
        asking = false;
      }
    };
    void ask();
    const timer = setInterval(() => void ask(), 2_000);
    // Back to the page: asked at once, not on the next beat.
    const back = () => {
      if (!document.hidden) void ask();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [changed]);

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
          version={version}
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
          onExecuteRemainder={setExecuting}
          onFloatRemainder={setFloatingLeft}
          onFresh={(line) =>
            // The open transfer as the list now has it: what is left of it, where it stands.
            setSelected((current) => (current && JSON.stringify(current) !== JSON.stringify(line) ? line : current))
          }
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
          // Sent in part, or closed short: only what is left goes on.
          selected?.paid && selected.status !== 'REVERSED' && BigInt(selected.paid) < BigInt(selected.amount)
            ? { amount: selected.amount, paid: selected.paid, currency: selected.currency }
            : null
        }
        executors={executors}
        onExecutors={setExecutors}
        onClose={() => setForwarding(null)}
        onForwarded={changed}
      />
      <MarkSentDialog line={sending} onClose={() => setSending(null)} onDone={changed} />
      {/* What is left of a transfer: sent with its receipt, or settled — here, or floating over the bank's site. */}
      <MarkSentDialog line={executing} remainder onClose={() => setExecuting(null)} onDone={changed} />
      <MarkSentDialog line={floatingLeft} remainder floatOnly onClose={() => setFloatingLeft(null)} onDone={changed} />
      {/* The row's floating window: the fields above the bank's site, and sent from there. */}
      <MarkSentDialog line={floatingLine} floatOnly onClose={() => setFloatingLine(null)} onDone={changed} />
    </div>
  );
}
