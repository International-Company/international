'use client';

import { useCallback, useState } from 'react';
import { ArrowRight, CornerUpRight, FileText, MessagesSquare, Workflow } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { cn } from '@/ui/utils';
import { BankView } from './bank-view';
import { GroupFeed } from './group-feed';
import { TransferDetail } from './transfer-detail';
import { ForwardPanel } from './forward-panel';
import { MarkSentDialog } from './mark-sent-dialog';
import { keyOf, type Line } from './desk-types';

/** Every column the same height: the page's, less its head. */
const TALL = 'h-[calc(100dvh-16rem)] min-h-[30rem]';
/** The same, once the three stand side by side: written out, for the stylesheet to find. */
const TALL_XL = 'xl:h-[calc(100dvh-16rem)] xl:min-h-[30rem]';

/**
 * The bank desk, in three columns.
 *
 * The bank group's transfers and messages in a list at the side; the one chosen
 * in full in the middle — where it came from, who sent it, what it says; and in
 * the third, passing it on to the groups that carry it out. On a smaller screen
 * the last two share a column under tabs; on a phone the list comes first and a
 * transfer opens over it. The other followed groups are a tab away, as they were.
 */
export function BankDesk() {
  const { t } = useLocale();
  const [mode, setMode] = useState<'work' | 'watch'>('work');
  const [selected, setSelected] = useState<Line | null>(null);
  /** The chosen line's key: set before the list has the line, when a message was just added as a request. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pane, setPane] = useState<'detail' | 'forward'>('detail');
  /** Bumped when one column changed something: the others ask again. */
  const [version, setVersion] = useState(0);
  const [sending, setSending] = useState<Line | null>(null);

  const changed = useCallback(() => setVersion((value) => value + 1), []);
  const choose = useCallback((line: Line | null) => {
    setSelected(line);
    setSelectedKey(line ? keyOf(line) : null);
  }, []);
  const pick = useCallback(
    (line: Line | null) => {
      // A new one chosen opens on its details.
      if (line && keyOf(line) !== selectedKey) setPane('detail');
      choose(line);
    },
    [choose, selectedKey],
  );

  return (
    <div className="space-y-3">
      {/* --- The desk, or the followed groups as they were --- */}
      <div className="inline-flex rounded-xl bg-surface-sunken p-1" role="tablist">
        {(
          [
            { key: 'work', icon: <Workflow className="size-4" />, label: t('bankDesk.workTab') },
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
              'inline-flex h-9 items-center gap-2 rounded-lg px-4 text-sm font-semibold transition-all',
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
      ) : (
        <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(19rem,23rem)_minmax(0,1fr)] xl:grid-cols-[minmax(19rem,23rem)_minmax(0,1fr)_minmax(19rem,22rem)]">
          {/* ① The list: on a phone, out of the way while one is open. */}
          <BankView
            selectedKey={selectedKey}
            onSelect={pick}
            version={version}
            onChanged={changed}
            className={cn(TALL, selectedKey ? 'hidden lg:flex' : 'flex')}
          />

          {/* ②③ The chosen one, and passing it on: side by side when there is room, else under tabs. */}
          <div className={cn('min-w-0 flex-col gap-2 xl:contents', TALL, 'xl:h-auto xl:min-h-0', selectedKey ? 'flex' : 'hidden lg:flex')}>
            <div className="flex items-center gap-2 xl:hidden">
              <button
                type="button"
                onClick={() => choose(null)}
                aria-label={t('common.back')}
                className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg px-2.5 text-sm font-semibold text-content-secondary ring-1 ring-border-subtle hover:bg-surface-sunken lg:hidden"
              >
                <ArrowRight className="size-4 ltr:rotate-180" />
                {t('bankDesk.listTab')}
              </button>
              <div className="flex flex-1 rounded-xl bg-surface-sunken p-1" role="tablist">
                {(
                  [
                    { key: 'detail', icon: <FileText className="size-4" />, label: t('bankDesk.detailTab') },
                    { key: 'forward', icon: <CornerUpRight className="size-4" />, label: t('bankDesk.forwardTab') },
                  ] as const
                ).map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    role="tab"
                    aria-selected={pane === option.key}
                    onClick={() => setPane(option.key)}
                    className={cn(
                      'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition-all',
                      pane === option.key
                        ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                        : 'text-content-tertiary hover:text-content-secondary',
                    )}
                  >
                    {option.icon}
                    {option.label}
                  </button>
                ))}
              </div>
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
              className={cn('min-h-0 flex-1', pane === 'detail' ? 'flex' : 'hidden', 'xl:flex', TALL_XL)}
            />
            <ForwardPanel
              messageId={selected?.messageId ?? null}
              onForwarded={changed}
              className={cn('min-h-0 flex-1', pane === 'forward' ? 'flex' : 'hidden', 'xl:flex', TALL_XL)}
            />
          </div>
        </div>
      )}

      <MarkSentDialog line={sending} onClose={() => setSending(null)} onDone={changed} />
    </div>
  );
}
