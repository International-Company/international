'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Clock, CornerUpLeft, CornerUpRight, FileText, Settings2, Share2 } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Textarea } from '@/ui/form';
import { cn } from '@/ui/utils';

interface Group {
  id: string;
  name: string;
}

interface FeedMessage {
  id: string;
  fromMe: boolean;
  senderName: string | null;
  senderPhone: string | null;
  text: string;
  mediaId: string | null;
  mediaKind: string | null;
  at: string;
  deal: { id: string; reference: string; status: string; sent: boolean } | null;
  forwardedTo: { group: string; auto: boolean; by: string | null; at: string }[];
  forwardedFrom: { group: string; auto: boolean; by: string | null } | null;
}

const time = (at: string) =>
  new Date(at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

/**
 * The groups the bank desk follows, live: every message as WhatsApp shows it,
 * the deal a message is the announcement of and whether its transfer went, and
 * where each was passed on — by a rule or by a person. Any message can be passed
 * on from here, by the bot, to the groups chosen.
 */
export function GroupFeed() {
  const { t } = useLocale();
  const toast = useToast();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [canChoose, setCanChoose] = useState(false);
  const [chat, setChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<FeedMessage[] | null>(null);
  const [everyGroup, setEveryGroup] = useState<Group[] | null>(null);
  const [choosing, setChoosing] = useState<Group[] | null>(null);
  const [forwarding, setForwarding] = useState<{ message: FeedMessage; targets: Group[]; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      ),
    [toast, t],
  );

  const loadGroups = useCallback(async () => {
    try {
      const result = await api.get<{ groups: Group[]; canChoose: boolean }>('/api/bank/groups');
      setGroups(result.groups);
      setCanChoose(result.canChoose);
      setChat((current) =>
        current && result.groups.some((group) => group.id === current) ? current : (result.groups[0]?.id ?? null),
      );
    } catch (cause) {
      failure(cause);
      setGroups([]);
    }
  }, [failure]);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const loadFeed = useCallback(async () => {
    if (!chat) return;
    try {
      setMessages(await api.get<FeedMessage[]>(`/api/bank/groups/feed?chat=${encodeURIComponent(chat)}`));
    } catch {
      setMessages((current) => current ?? []);
    }
  }, [chat]);

  useEffect(() => {
    setMessages(null);
    void loadFeed();
    // A tab nobody is looking at asks nothing; it catches up when shown.
    const timer = setInterval(() => {
      if (!document.hidden) void loadFeed();
    }, 5_000);
    return () => clearInterval(timer);
  }, [loadFeed]);

  // The newest at the bottom, as in WhatsApp, followed while it grows.
  const lastId = messages?.at(-1)?.id;
  useEffect(() => {
    const list = scroller.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lastId]);

  const loadEveryGroup = async () => {
    if (everyGroup) return everyGroup;
    try {
      const all = await api.get<Group[]>('/api/bank/groups/all');
      setEveryGroup(all);
      return all;
    } catch (cause) {
      failure(cause);
      return [];
    }
  };

  const saveChoice = async () => {
    if (!choosing) return;
    setBusy(true);
    try {
      await api.put('/api/bank/groups', { groups: choosing });
      setChoosing(null);
      await loadGroups();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const sendOn = async () => {
    if (!forwarding || forwarding.targets.length === 0) return;
    setBusy(true);
    try {
      const result = await api.post<{ sent: string[] }>(
        `/api/bank/groups/messages/${forwarding.message.id}/forward`,
        { targets: forwarding.targets, text: forwarding.text },
      );
      toast.success(t('bankFeed.forwarded'), result.sent.join('، '));
      setForwarding(null);
      void loadFeed();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (list: Group[], group: Group) =>
    list.some((entry) => entry.id === group.id)
      ? list.filter((entry) => entry.id !== group.id)
      : [...list, group];

  const groupPicker = (chosen: Group[], onChange: (next: Group[]) => void, exclude?: string) => (
    <div className="max-h-80 space-y-1 overflow-y-auto">
      {everyGroup === null ? (
        <Skeleton className="h-24" />
      ) : (
        everyGroup
          .filter((group) => group.id !== exclude)
          .map((group) => (
            <label
              key={group.id}
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                checked={chosen.some((entry) => entry.id === group.id)}
                onChange={() => onChange(toggle(chosen, group))}
              />
              {group.name}
            </label>
          ))
      )}
    </div>
  );

  return (
    <Card className="flex h-[78vh] min-h-[28rem] flex-col overflow-hidden p-0">
      {/* --- One tab per followed group --- */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border-subtle p-2">
        {(groups ?? []).map((group) => (
          <button
            key={group.id}
            type="button"
            aria-pressed={chat === group.id}
            onClick={() => setChat(group.id)}
            className={cn(
              'h-9 shrink-0 rounded-full px-3 text-sm font-medium transition-colors',
              chat === group.id ? 'bg-primary text-white' : 'text-content-secondary hover:bg-surface-sunken',
            )}
          >
            {group.name}
          </button>
        ))}
        {canChoose && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Settings2 />}
            className="ms-auto shrink-0"
            onClick={() => {
              setChoosing(groups ?? []);
              void loadEveryGroup();
            }}
          >
            {t('bankFeed.choose')}
          </Button>
        )}
      </div>

      {/* --- The conversation --- */}
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-surface-sunken p-3">
        {groups !== null && groups.length === 0 ? (
          <EmptyState
            title={t('bankFeed.noGroupsTitle')}
            description={canChoose ? t('bankFeed.noGroupsManager') : t('bankFeed.noGroupsDesk')}
          />
        ) : messages === null ? (
          <Skeleton className="h-40" />
        ) : messages.length === 0 ? (
          <EmptyState title={t('bankFeed.emptyTitle')} description={t('bankFeed.emptyBody')} />
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                'group max-w-[92%] rounded-2xl px-3 py-2 text-sm',
                message.fromMe
                  ? 'self-end bg-success-subtle text-content'
                  : 'self-start bg-surface text-content ring-1 ring-border-subtle',
              )}
            >
              <p className="mb-0.5 text-[11px] font-semibold text-primary-text">
                {message.fromMe
                  ? t('bankFeed.office')
                  : (message.senderName ?? (message.senderPhone ? `+${message.senderPhone}` : t('bankFeed.member')))}
              </p>
              {message.forwardedFrom && (
                <p className="mb-1 flex items-center gap-1 text-[11px] text-content-tertiary">
                  <CornerUpLeft className="size-3" />
                  {t('bankFeed.from', { group: message.forwardedFrom.group })}
                  {message.forwardedFrom.by && ` · ${message.forwardedFrom.by}`}
                </p>
              )}
              {message.mediaId && message.mediaKind === 'image' && (
                <a href={`/api/bank/groups/media/${message.mediaId}`} target="_blank" rel="noopener noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/bank/groups/media/${message.mediaId}`}
                    alt=""
                    loading="lazy"
                    className="mb-1 max-h-60 rounded-lg object-contain"
                  />
                </a>
              )}
              {message.mediaId && message.mediaKind === 'document' && (
                <a
                  href={`/api/bank/groups/media/${message.mediaId}`}
                  className="mb-1 inline-flex items-center gap-1 text-primary-text"
                >
                  <FileText className="size-4" />
                  {t('bankFeed.file')}
                </a>
              )}
              {!message.mediaId && message.mediaKind && (
                <p className="text-xs text-content-tertiary">📎 {t('bankFeed.fileNotKept')}</p>
              )}
              {message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>}

              {/* The deal it announces, and whether its transfer went. */}
              {message.deal && (
                <Link
                  href={`/manage/transactions/${message.deal.id}`}
                  className={cn(
                    'mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                    message.deal.sent || message.deal.status === 'POSTED'
                      ? 'bg-success-subtle text-success-text'
                      : 'bg-warning-subtle text-warning-text',
                  )}
                >
                  {message.deal.status === 'PENDING_TRANSFER' ? (
                    <Clock className="size-3" />
                  ) : (
                    <CheckCircle2 className="size-3" />
                  )}
                  <span className="ltr-content font-mono">{message.deal.reference}</span>
                  {message.deal.status === 'PENDING_TRANSFER'
                    ? t('bankFeed.waiting')
                    : message.deal.status === 'REVERSED'
                      ? t('bankFeed.reversed')
                      : message.deal.sent
                        ? t('bankFeed.sent')
                        : ''}
                </Link>
              )}

              {/* Where it went from here. */}
              {message.forwardedTo.map((entry, index) => (
                <p key={index} className="mt-1 flex items-center gap-1 text-[11px] text-content-tertiary">
                  <CornerUpRight className="size-3" />
                  {t('bankFeed.to', { group: entry.group })} ·{' '}
                  {entry.auto ? t('bankFeed.auto') : (entry.by ?? '')}
                </p>
              ))}

              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[11px] tabular-nums text-content-tertiary">{time(message.at)}</span>
                <button
                  type="button"
                  onClick={() => {
                    setForwarding({ message, targets: [], text: message.text });
                    void loadEveryGroup();
                  }}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-primary-text hover:bg-primary-subtle"
                >
                  <Share2 className="size-3" />
                  {t('bankFeed.forward')}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* --- Which groups the desk follows --- */}
      <Dialog
        open={choosing !== null}
        onClose={() => setChoosing(null)}
        title={t('bankFeed.choose')}
        description={t('bankFeed.chooseHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setChoosing(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void saveChoice()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        {choosing && groupPicker(choosing, (next) => setChoosing(next.slice(0, 10)))}
      </Dialog>

      {/* --- Passing a message on, by the bot --- */}
      <Dialog
        open={forwarding !== null}
        onClose={() => setForwarding(null)}
        title={t('bankFeed.forwardTitle')}
        description={t('bankFeed.forwardHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setForwarding(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!forwarding || forwarding.targets.length === 0}
              onClick={() => void sendOn()}
            >
              {t('bankFeed.send')}
            </Button>
          </>
        }
      >
        {forwarding && (
          <div className="space-y-3">
            {forwarding.message.mediaId && forwarding.message.mediaKind === 'image' && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={`/api/bank/groups/media/${forwarding.message.mediaId}`}
                alt=""
                className="max-h-40 rounded-lg object-contain"
              />
            )}
            <Field label={t('bankFeed.text')}>
              {(props) => (
                <Textarea
                  {...props}
                  rows={4}
                  value={forwarding.text}
                  onChange={(event) => setForwarding({ ...forwarding, text: event.target.value })}
                />
              )}
            </Field>
            <p className="text-xs font-medium text-content-secondary">{t('bankFeed.targets')}</p>
            {groupPicker(
              forwarding.targets,
              (next) => setForwarding({ ...forwarding, targets: next }),
              chat ?? undefined,
            )}
          </div>
        )}
      </Dialog>
    </Card>
  );
}
