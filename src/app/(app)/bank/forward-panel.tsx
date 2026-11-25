'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCheck, CornerUpRight, History, RotateCcw, Search, SplitSquareHorizontal, Star, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Skeleton } from '@/ui/primitives';
import { useToast } from '@/ui/overlay';
import { Switch, Textarea } from '@/ui/form';
import { cn } from '@/ui/utils';
import { clockOf, dayKey, dayLabel } from './days';
import { plainFigure } from './desk-types';

/** A stored sum (scaled by 1e8) as the group reads it: 1,250 or 1,250.5. */
const spoken = (scaled: bigint) => {
  const [whole, fraction = ''] = plainFigure(scaled.toString()).split('.');
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
};

/** A money's name as the groups write it. */
const MONEY_WORD: Record<string, string> = { ILS: 'شيكل', USD: 'دولار', JOD: 'دينار', EUR: 'يورو', EGP: 'جنيه' };

const UNIT = 100_000_000n;

/**
 * The transfer's words with only what is left of it: the sum where it is
 * written changed to what is left, written the same way — "6741 شيكل" becomes
 * "1429 شيكل", "6,741.54" becomes "1,429.54" — or, not written in them, what is
 * left at their end in their manner. The group that carries it out sees no
 * other sum, so it sends no more than that.
 */
function leftWords(text: string, left: { amount: string; paid: string; currency: string }): string {
  const total = BigInt(left.amount || '0');
  const rest = total - BigInt(left.paid || '0');
  if (rest <= 0n) return text;
  const restWhole = (rest / UNIT).toString();
  const withCommas = (digits: string) => digits.replace(/(?=(?:[0-9]{3})+$)(?!^)/g, ',');
  // The sum as it may be written: its whole part (cut, or rounded), with or without its fraction and commas.
  const wholes = [...new Set([(total / UNIT).toString(), ((total + UNIT / 2n) / UNIT).toString()])];
  let replaced = text;
  for (const digits of wholes) {
    const grouped = digits.replace(/(?=(?:[0-9]{3})+$)(?!^)/g, ',?');
    // No backslashes: [0-9] and [.] read the same however the line is written. Not part of an account or a longer number.
    const pattern = new RegExp('(?<![0-9.,])' + grouped + '(?:[.][0-9]+)?(?![0-9,]|[.][0-9])', 'g');
    replaced = replaced.replace(pattern, (found) => {
      const plain = found.includes('.') ? plainFigure(rest.toString()) : restWhole;
      if (!found.includes(',')) return plain;
      const [head, tail] = plain.split('.');
      return tail ? `${withCommas(head!)}.${tail}` : withCommas(head!);
    });
    if (replaced !== text) return replaced;
  }
  return `${text.trimEnd()}\n${restWhole} ${MONEY_WORD[left.currency] ?? left.currency}`;
}

export interface Group {
  id: string;
  name: string;
}

interface Trace {
  message: { group: string; text: string; mediaId: string | null; mediaKind: string | null };
  forwards: { group: string; auto: boolean; by: string | null; at: string; delivered: boolean }[];
}

/** The groups last chosen, ticked again for the next transfer: a convenience of this browser. */
const LAST_TARGETS = 'bank.forward.lastTargets';

export function lastTargets(): Group[] {
  try {
    const raw = window.localStorage.getItem(LAST_TARGETS);
    const list = raw ? (JSON.parse(raw) as Group[]) : [];
    return Array.isArray(list) ? list.filter((group) => group?.id && group?.name) : [];
  } catch {
    return [];
  }
}

function rememberTargets(groups: Group[]) {
  try {
    window.localStorage.setItem(LAST_TARGETS, JSON.stringify(groups));
  } catch {
    // Not kept: ticked again by hand next time.
  }
}

/** One group to tick, with its star: pinned, it is offered first and in the details' quick buttons. */
function GroupOption({
  group,
  checked,
  onToggle,
  pinned,
  onPin,
  sentAt,
}: {
  group: Group;
  checked: boolean;
  onToggle: () => void;
  pinned: boolean;
  onPin: () => void;
  sentAt?: string | null;
}) {
  const { t } = useLocale();
  return (
    <div
      className={cn(
        'flex items-center rounded-xl ring-1 transition-colors',
        checked ? 'bg-primary-subtle/70 ring-primary/40' : 'bg-surface ring-border-subtle hover:bg-surface-sunken',
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-start"
      >
        <span
          className={cn(
            'flex size-[18px] shrink-0 items-center justify-center rounded-md ring-1 transition-colors',
            checked ? 'bg-primary text-white ring-primary' : 'bg-surface ring-border',
          )}
        >
          {checked && <Check className="size-3" strokeWidth={3} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-content">{group.name}</span>
          {sentAt && (
            <span className="mt-0.5 flex items-center gap-0.5 text-[10px] font-medium text-success-text">
              <CheckCheck className="size-3" />
              {t('bankDesk.alreadySent', { time: clockOf(sentAt) })}
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onPin}
        aria-pressed={pinned}
        title={pinned ? t('bankDesk.unpin') : t('bankDesk.pin')}
        aria-label={pinned ? t('bankDesk.unpin') : t('bankDesk.pin')}
        className={cn(
          'me-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
          pinned ? 'text-warning' : 'text-content-tertiary/60 hover:bg-surface-sunken hover:text-warning',
        )}
      >
        <Star className={cn('size-4', pinned && 'fill-current')} />
      </button>
    </div>
  );
}

/**
 * Passing a transfer's message on, in a sheet over the side of the desk: the
 * pinned executing groups first, every other group under them with a search,
 * a star on each to pin it; the words open to correct, seen as WhatsApp will
 * show them, the photo with them or not; and where this message went already.
 */
export function ForwardSheet({
  open,
  messageId,
  preset,
  executors,
  onExecutors,
  onClose,
  onForwarded,
  left = null,
}: {
  /** Sent in part already: what is left of it is what is passed on. */
  left?: { amount: string; paid: string; currency: string } | null;
  open: boolean;
  messageId: string | null;
  /** Groups ticked on opening: the quick button pressed. */
  preset?: Group[] | null;
  /** The pinned executing groups. */
  executors: Group[];
  /** The pinned groups changed. */
  onExecutors: (groups: Group[]) => void;
  onClose: () => void;
  onForwarded: () => void;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [everyGroup, setEveryGroup] = useState<Group[] | null>(null);
  const [targets, setTargets] = useState<Group[]>([]);
  const [text, setText] = useState('');
  const [withPhoto, setWithPhoto] = useState(true);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      ),
    [toast, t],
  );

  // Opened: the message, every group, and the groups to tick.
  useEffect(() => {
    if (!open || !messageId) return;
    let gone = false;
    setTrace(null);
    setQuery('');
    setWithPhoto(true);
    api
      .get<Trace>(`/api/bank/groups/messages/${messageId}/trace`)
      .then((result) => {
        if (gone) return;
        setTrace(result);
        // Sent in part: only what is left goes on.
        setText(left ? leftWords(result.message.text, left) : result.message.text);
      })
      .catch((cause) => !gone && failure(cause));
    if (!everyGroup) {
      api
        .get<Group[]>('/api/bank/groups/all')
        .then((all) => !gone && setEveryGroup(all))
        .catch((cause) => {
          if (gone) return;
          setEveryGroup([]);
          failure(cause);
        });
    }
    const last = lastTargets().filter((group) => executors.some((entry) => entry.id === group.id));
    setTargets(preset?.length ? preset : last.length ? last : executors.length === 1 ? executors : []);
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, messageId]);

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (group: Group) =>
    setTargets((chosen) =>
      chosen.some((entry) => entry.id === group.id)
        ? chosen.filter((entry) => entry.id !== group.id)
        : [...chosen, group],
    );
  const isPinned = (group: Group) => executors.some((entry) => entry.id === group.id);
  const pin = async (group: Group) => {
    const next = isPinned(group) ? executors.filter((entry) => entry.id !== group.id) : [...executors, group];
    try {
      onExecutors(await api.put<Group[]>('/api/bank/groups/executors', { groups: next }));
    } catch (cause) {
      failure(cause);
    }
  };
  const sentTo = (group: Group) => trace?.forwards.filter((entry) => entry.group === group.name).at(-1)?.at ?? null;

  const send = async () => {
    if (!messageId || targets.length === 0) return;
    setBusy(true);
    try {
      const result = await api.post<{ sent: string[] }>(`/api/bank/groups/messages/${messageId}/forward`, {
        targets,
        text,
        withPhoto,
      });
      rememberTargets(targets);
      toast.success(t('bankFeed.forwarded'), result.sent.join('، '));
      onForwarded();
      onClose();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const hasPhoto = Boolean(trace?.message.mediaId && trace.message.mediaKind === 'image');
  const needle = query.trim().toLowerCase();
  const others = (everyGroup ?? [])
    .filter((group) => !isPinned(group))
    .filter((group) => group.name !== trace?.message.group)
    .filter((group) => !needle || group.name.toLowerCase().includes(needle));
  const when = (at: string) =>
    `${dayLabel(dayKey(at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') })} · ${clockOf(at)}`;
  const option = (group: Group) => (
    <GroupOption
      key={group.id}
      group={group}
      checked={targets.some((entry) => entry.id === group.id)}
      onToggle={() => toggle(group)}
      pinned={isPinned(group)}
      onPin={() => void pin(group)}
      sentAt={sentTo(group)}
    />
  );

  return createPortal(
    <div className="fixed inset-0 z-[55] flex" role="dialog" aria-modal="true" aria-label={t('bankDesk.forwardTitle')}>
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={onClose}
        className="flex-1 animate-[sheet-fade_160ms_ease-out] bg-black/30 backdrop-blur-[1px]"
      />
      <aside className="flex h-full w-full max-w-md animate-[sheet-in_200ms_ease-out] flex-col bg-surface shadow-[0_0_60px_-10px_rgb(0_0_0/0.45)]">
        <style>
          {'@keyframes sheet-in{from{opacity:.4;transform:translateX(var(--sheet-from,-24px))}to{opacity:1;transform:none}}@keyframes sheet-fade{from{opacity:0}to{opacity:1}}[dir=ltr] aside{--sheet-from:24px}'}
        </style>
        {/* --- The head --- */}
        <header className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-white">
            <CornerUpRight className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-content">{t('bankDesk.forwardTitle')}</h2>
            <p className="truncate text-[11px] text-content-tertiary">{t('bankDesk.forwardSubtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
          >
            <X className="size-4" />
          </button>
        </header>

        {!trace ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-28" />
            <Skeleton className="h-24" />
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-surface-sunken/40 p-3">
              {/* --- The groups: the pinned first, then all the rest --- */}
              <section>
                <h3 className="mb-1.5 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                  <span className="inline-flex items-center gap-1">
                    <Star className="size-3 fill-current text-warning" />
                    {t('bankDesk.executors')}
                  </span>
                  {targets.length > 0 && (
                    <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold normal-case text-white tabular-nums">
                      {targets.length}
                    </span>
                  )}
                </h3>
                {executors.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-center text-[11px] text-content-secondary">
                    {t('bankDesk.pinHint')}
                  </p>
                ) : (
                  <div className="space-y-1.5">{executors.map(option)}</div>
                )}
              </section>

              <section>
                <h3 className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                  {t('bankDesk.allGroups')}
                </h3>
                <div className="relative mb-1.5">
                  <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-content-tertiary" />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('bankDesk.searchGroups')}
                    className="h-9 w-full rounded-xl bg-surface ps-8 pe-2 text-xs text-content outline-none ring-1 ring-border-subtle focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div className="max-h-64 space-y-1.5 overflow-y-auto">
                  {everyGroup === null ? (
                    <Skeleton className="h-24" />
                  ) : others.length === 0 ? (
                    <p className="p-2 text-center text-[11px] text-content-tertiary">{t('bank.noGroups')}</p>
                  ) : (
                    others.map(option)
                  )}
                </div>
              </section>

              {/* --- The words, and how they will look --- */}
              <section>
                <div className="mb-1.5 flex items-center justify-between px-1">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">{t('bankFeed.text')}</h3>
                  {text !== trace.message.text && (
                    <button
                      type="button"
                      onClick={() => setText(trace.message.text)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-primary-text hover:underline"
                    >
                      <RotateCcw className="size-3" />
                      {t('bankDesk.restoreText')}
                    </button>
                  )}
                </div>
                {left && BigInt(left.paid || '0') > 0n && (
                  <div className="mb-2 flex items-center gap-2 rounded-xl bg-warning-subtle/60 px-2.5 py-2 ring-1 ring-warning/30">
                    <SplitSquareHorizontal className="size-4 shrink-0 text-warning-text" />
                    <span className="min-w-0 flex-1 text-[12px] font-semibold text-warning-text">
                      {t('bankParts.forwardLeft', {
                        left: spoken(BigInt(left.amount) - BigInt(left.paid)),
                        currency: left.currency,
                      })}
                    </span>
                    <button
                      type="button"
                      onClick={() => setText(leftWords(trace.message.text, left))}
                      className="shrink-0 rounded-lg bg-warning px-2 py-1 text-[11px] font-bold text-white hover:bg-warning/90"
                    >
                      {t('bankParts.forwardLeftUse')}
                    </button>
                  </div>
                )}
                <Textarea
                  rows={4}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  aria-label={t('bankFeed.text')}
                  className="text-[13px]"
                />
                {hasPhoto && (
                  <Switch className="mt-2 px-1" checked={withPhoto} onCheckedChange={setWithPhoto} label={t('bankDesk.withPhoto')} />
                )}
                <p className="mb-1.5 mt-3 px-1 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                  {t('bankDesk.preview')}
                </p>
                <div className="rounded-xl bg-surface-sunken p-3 [background-image:radial-gradient(rgb(0_0_0/0.035)_1px,transparent_1px)] [background-size:12px_12px]">
                  <div className="ms-auto w-fit max-w-[92%] rounded-xl rounded-se-sm bg-success-subtle px-2.5 py-1.5 text-[13px] text-content shadow-[0_1px_0.5px_rgb(0_0_0/0.13)]">
                    {hasPhoto && withPhoto && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={`/api/bank/groups/media/${trace.message.mediaId}`}
                        alt=""
                        className="mb-1 max-h-36 rounded-lg object-contain"
                      />
                    )}
                    <p className="whitespace-pre-wrap break-words">{text || (hasPhoto && withPhoto ? '' : '—')}</p>
                    <p className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-content-tertiary">
                      {t('bankDesk.now')}
                      <CheckCheck className="size-3 text-primary" />
                    </p>
                  </div>
                </div>
              </section>

              {/* --- Where it went already --- */}
              <section>
                <h3 className="mb-1.5 flex items-center gap-1 px-1 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                  <History className="size-3" />
                  {t('bankDesk.history')}
                </h3>
                {trace.forwards.length === 0 ? (
                  <p className="rounded-xl bg-surface px-3 py-2.5 text-center text-[11px] text-content-tertiary ring-1 ring-border-subtle">
                    {t('bankDesk.historyEmpty')}
                  </p>
                ) : (
                  <ol className="space-y-1">
                    {[...trace.forwards].reverse().map((forward, index) => (
                      <li
                        key={`${forward.group}-${forward.at}-${index}`}
                        className="flex items-center gap-2 rounded-lg bg-surface px-2 py-1.5 text-xs ring-1 ring-border-subtle"
                      >
                        <span
                          className={cn(
                            'flex size-6 shrink-0 items-center justify-center rounded-full',
                            forward.delivered ? 'bg-success-subtle text-success-text' : 'bg-warning-subtle text-warning-text',
                          )}
                        >
                          {forward.delivered ? <CheckCheck className="size-3.5" /> : <CornerUpRight className="size-3.5" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold text-content">{forward.group}</span>
                          <span className="block truncate text-[10px] text-content-tertiary">
                            {forward.auto ? t('bankFeed.auto') : forward.by} · {when(forward.at)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>

            {/* --- Send --- */}
            <footer className="border-t border-border-subtle bg-surface p-3">
              <Button
                variant="primary"
                fullWidth
                loading={busy}
                icon={<CornerUpRight />}
                disabled={targets.length === 0 || (!text.trim() && !(hasPhoto && withPhoto))}
                onClick={() => void send()}
              >
                {targets.length === 0
                  ? t('bankDesk.pickGroup')
                  : targets.length === 1
                    ? t('bankDesk.sendToOne', { group: targets[0]!.name })
                    : t('bankDesk.sendTo', { count: targets.length })}
              </Button>
            </footer>
          </>
        )}
      </aside>
    </div>,
    document.body,
  );
}
