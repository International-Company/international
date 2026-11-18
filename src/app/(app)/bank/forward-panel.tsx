'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  CheckCheck,
  ChevronDown,
  CornerUpRight,
  History,
  RotateCcw,
  Search,
  Settings2,
  Star,
  Users,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Switch, Textarea } from '@/ui/form';
import { cn } from '@/ui/utils';
import { clockOf, dayKey, dayLabel } from './days';

interface Group {
  id: string;
  name: string;
}

interface Trace {
  message: { group: string; text: string; mediaId: string | null; mediaKind: string | null };
  forwards: { group: string; auto: boolean; by: string | null; at: string; delivered: boolean }[];
}

/** The groups last chosen, ticked again for the next transfer: a convenience of this browser. */
const LAST_TARGETS = 'bank.forward.lastTargets';

function lastTargets(): Group[] {
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

/** One group to tick: its name, and whether it was the last used or already has this transfer. */
function GroupOption({
  group,
  checked,
  onToggle,
  last,
  sentAt,
}: {
  group: Group;
  checked: boolean;
  onToggle: () => void;
  last?: boolean;
  sentAt?: string | null;
}) {
  const { t } = useLocale();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-start ring-1 transition-colors',
        checked
          ? 'bg-primary-subtle/70 ring-primary/40'
          : 'bg-surface ring-border-subtle hover:bg-surface-sunken',
      )}
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
        {(last || sentAt) && (
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] font-medium">
            {last && (
              <span className="inline-flex items-center gap-0.5 text-warning-text">
                <Star className="size-2.5 fill-current" />
                {t('bankDesk.lastUsed')}
              </span>
            )}
            {sentAt && (
              <span className="inline-flex items-center gap-0.5 text-success-text">
                <CheckCheck className="size-3" />
                {t('bankDesk.alreadySent', { time: clockOf(sentAt) })}
              </span>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The third column: a transfer's message passed on by the bot to the groups that
 * carry it out. The executing groups first, as the manager chose them, the last
 * used ticked again; every other group a fold away. The words open to correct,
 * seen as WhatsApp will show them, the photo with them or not; and under it all,
 * where this message has gone already.
 */
export function ForwardPanel({
  messageId,
  onForwarded,
  className,
}: {
  messageId: string | null;
  onForwarded: () => void;
  className?: string;
}) {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [executors, setExecutors] = useState<Group[] | null>(null);
  const [canChoose, setCanChoose] = useState(false);
  const [everyGroup, setEveryGroup] = useState<Group[] | null>(null);
  const [targets, setTargets] = useState<Group[]>([]);
  const [text, setText] = useState('');
  const [withPhoto, setWithPhoto] = useState(true);
  const [othersOpen, setOthersOpen] = useState(false);
  const [othersQuery, setOthersQuery] = useState('');
  const [busy, setBusy] = useState(false);
  /** Choosing the executing groups, for the manager. */
  const [choosing, setChoosing] = useState<Group[] | null>(null);

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      ),
    [toast, t],
  );

  const loadExecutors = useCallback(async () => {
    try {
      const result = await api.get<{ groups: Group[]; canChoose: boolean }>('/api/bank/groups/executors');
      setExecutors(result.groups);
      setCanChoose(result.canChoose);
      return result.groups;
    } catch (cause) {
      setExecutors([]);
      failure(cause);
      return [];
    }
  }, [failure]);

  const loadEveryGroup = useCallback(async () => {
    if (everyGroup) return everyGroup;
    try {
      const all = await api.get<Group[]>('/api/bank/groups/all');
      setEveryGroup(all);
      return all;
    } catch (cause) {
      setEveryGroup([]);
      failure(cause);
      return [];
    }
  }, [everyGroup, failure]);

  useEffect(() => {
    void loadExecutors();
  }, [loadExecutors]);

  const loadTrace = useCallback(
    async (id: string) => {
      try {
        const result = await api.get<Trace>(`/api/bank/groups/messages/${id}/trace`);
        setTrace(result);
        return result;
      } catch (cause) {
        failure(cause);
        return null;
      }
    },
    [failure],
  );

  // A new transfer chosen: its words, its photo, and last time's groups ticked again.
  useEffect(() => {
    setTrace(null);
    setOthersQuery('');
    if (!messageId) return;
    let gone = false;
    void loadTrace(messageId).then((result) => {
      if (gone || !result) return;
      setText(result.message.text);
      setWithPhoto(true);
    });
    return () => {
      gone = true;
    };
  }, [messageId, loadTrace]);

  useEffect(() => {
    if (!messageId || executors === null) return;
    const last = lastTargets();
    const ticked = last.filter((group) => executors.some((entry) => entry.id === group.id));
    // Others last used stay ticked too, once the full list says they still exist.
    const others = last.filter(
      (group) => !executors.some((entry) => entry.id === group.id) && everyGroup?.some((entry) => entry.id === group.id),
    );
    setTargets(ticked.length || others.length ? [...ticked, ...others] : executors.length === 1 ? executors : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageId, executors]);

  const lastIds = useMemo(() => new Set(lastTargets().map((group) => group.id)), [messageId, busy]);
  const sentTo = (group: Group) =>
    trace?.forwards.filter((entry) => entry.group === group.name).at(-1)?.at ?? null;

  const toggle = (group: Group) =>
    setTargets((chosen) =>
      chosen.some((entry) => entry.id === group.id)
        ? chosen.filter((entry) => entry.id !== group.id)
        : [...chosen, group],
    );

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
      await loadTrace(messageId);
      onForwarded();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const saveExecutors = async () => {
    if (!choosing) return;
    setBusy(true);
    try {
      await api.put('/api/bank/groups/executors', { groups: choosing });
      setChoosing(null);
      await loadExecutors();
      toast.success(t('bankDesk.executorsSaved'));
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const hasPhoto = Boolean(trace?.message.mediaId && trace.message.mediaKind === 'image');
  const others = (everyGroup ?? [])
    .filter((group) => !executors?.some((entry) => entry.id === group.id))
    .filter((group) => group.name !== trace?.message.group)
    .filter((group) => !othersQuery.trim() || group.name.toLowerCase().includes(othersQuery.trim().toLowerCase()))
    // The last used first.
    .sort((a, b) => Number(lastIds.has(b.id)) - Number(lastIds.has(a.id)));
  const chosenOthers = targets.filter((group) => !executors?.some((entry) => entry.id === group.id)).length;
  const when = (at: string) =>
    `${dayLabel(dayKey(at), locale, { today: t('bank.period.today'), yesterday: t('bank.period.yesterday') })} · ${clockOf(at)}`;

  return (
    <Card className={cn('flex flex-col overflow-hidden p-0', className)}>
      {/* --- The head --- */}
      <header className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-white">
          <CornerUpRight className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-content">{t('bankDesk.forwardTitle')}</h2>
          <p className="truncate text-[11px] text-content-tertiary">{t('bankDesk.forwardSubtitle')}</p>
        </div>
        {canChoose && (
          <button
            type="button"
            onClick={() => {
              setChoosing(executors ?? []);
              void loadEveryGroup();
            }}
            title={t('bankDesk.manageExecutors')}
            aria-label={t('bankDesk.manageExecutors')}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-content-tertiary ring-1 ring-border-subtle hover:bg-surface-sunken hover:text-content"
          >
            <Settings2 className="size-4" />
          </button>
        )}
      </header>

      {!messageId ? (
        <div className="flex flex-1 items-center justify-center p-4">
          <EmptyState
            icon={<CornerUpRight />}
            title={t('bankDesk.forwardNone')}
            description={t('bankDesk.forwardNoneHint')}
          />
        </div>
      ) : !trace ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-28" />
          <Skeleton className="h-24" />
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
            {/* --- The groups that carry it out --- */}
            <section>
              <h3 className="mb-1.5 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                {t('bankDesk.executors')}
                {targets.length > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] font-bold normal-case text-white tabular-nums">
                    {targets.length}
                  </span>
                )}
              </h3>
              {executors === null ? (
                <Skeleton className="h-24" />
              ) : executors.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-3 text-center">
                  <p className="text-xs text-content-secondary">{t('bankDesk.noExecutors')}</p>
                  {canChoose ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Settings2 />}
                      className="mt-2"
                      onClick={() => {
                        setChoosing([]);
                        void loadEveryGroup();
                      }}
                    >
                      {t('bankDesk.chooseExecutors')}
                    </Button>
                  ) : (
                    <p className="mt-1 text-[11px] text-content-tertiary">{t('bankDesk.executorsByManager')}</p>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {executors.map((group) => (
                    <GroupOption
                      key={group.id}
                      group={group}
                      checked={targets.some((entry) => entry.id === group.id)}
                      onToggle={() => toggle(group)}
                      last={lastIds.has(group.id)}
                      sentAt={sentTo(group)}
                    />
                  ))}
                </div>
              )}

              {/* Every other group, a fold away. */}
              <button
                type="button"
                onClick={() => {
                  setOthersOpen((open) => !open);
                  void loadEveryGroup();
                }}
                aria-expanded={othersOpen}
                className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-xs font-semibold text-content-secondary hover:text-content"
              >
                <Users className="size-3.5" />
                {t('bankDesk.otherGroups')}
                {chosenOthers > 0 && (
                  <span className="rounded-full bg-primary-subtle px-1.5 text-[10px] text-primary-text tabular-nums">
                    {chosenOthers}
                  </span>
                )}
                <ChevronDown className={cn('ms-auto size-3.5 transition-transform', othersOpen && 'rotate-180')} />
              </button>
              {othersOpen && (
                <div className="mt-1 space-y-1.5">
                  <div className="relative">
                    <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-content-tertiary" />
                    <input
                      type="search"
                      value={othersQuery}
                      onChange={(event) => setOthersQuery(event.target.value)}
                      placeholder={t('bankDesk.searchGroups')}
                      className="h-8 w-full rounded-lg bg-surface-sunken ps-8 pe-2 text-xs text-content outline-none ring-1 ring-transparent focus:bg-surface focus:ring-primary"
                    />
                  </div>
                  <div className="max-h-56 space-y-1.5 overflow-y-auto">
                    {everyGroup === null ? (
                      <Skeleton className="h-20" />
                    ) : others.length === 0 ? (
                      <p className="p-2 text-center text-[11px] text-content-tertiary">{t('bank.noGroups')}</p>
                    ) : (
                      others.map((group) => (
                        <GroupOption
                          key={group.id}
                          group={group}
                          checked={targets.some((entry) => entry.id === group.id)}
                          onToggle={() => toggle(group)}
                          last={lastIds.has(group.id)}
                          sentAt={sentTo(group)}
                        />
                      ))
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* --- The words, and how they will look --- */}
            <section>
              <div className="mb-1.5 flex items-center justify-between px-1">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-content-tertiary">
                  {t('bankFeed.text')}
                </h3>
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
              <Textarea
                rows={4}
                value={text}
                onChange={(event) => setText(event.target.value)}
                aria-label={t('bankFeed.text')}
                className="text-[13px]"
              />
              {hasPhoto && (
                <Switch
                  className="mt-2 px-1"
                  checked={withPhoto}
                  onCheckedChange={setWithPhoto}
                  label={t('bankDesk.withPhoto')}
                />
              )}

              {/* As WhatsApp will show it. */}
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
                <p className="rounded-xl bg-surface-sunken px-3 py-2.5 text-center text-[11px] text-content-tertiary">
                  {t('bankDesk.historyEmpty')}
                </p>
              ) : (
                <ol className="space-y-1">
                  {[...trace.forwards].reverse().map((forward, index) => (
                    <li
                      key={`${forward.group}-${forward.at}-${index}`}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-surface-sunken"
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
                : t('bankDesk.sendTo', { count: targets.length })}
            </Button>
          </footer>
        </>
      )}

      {/* --- The manager chooses the executing groups --- */}
      <Dialog
        open={choosing !== null}
        onClose={() => setChoosing(null)}
        title={t('bankDesk.manageExecutors')}
        description={t('bankDesk.manageExecutorsHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setChoosing(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void saveExecutors()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {choosing && (
          <div className="max-h-80 space-y-1.5 overflow-y-auto">
            {everyGroup === null ? (
              <Skeleton className="h-24" />
            ) : everyGroup.length === 0 ? (
              <p className="p-3 text-center text-xs text-content-tertiary">{t('bank.noGroups')}</p>
            ) : (
              everyGroup.map((group) => (
                <GroupOption
                  key={group.id}
                  group={group}
                  checked={choosing.some((entry) => entry.id === group.id)}
                  onToggle={() =>
                    setChoosing(
                      choosing.some((entry) => entry.id === group.id)
                        ? choosing.filter((entry) => entry.id !== group.id)
                        : [...choosing, group],
                    )
                  }
                />
              ))
            )}
          </div>
        )}
      </Dialog>
    </Card>
  );
}
