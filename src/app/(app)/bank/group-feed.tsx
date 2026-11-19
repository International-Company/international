'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  ClipboardList,
  Clock,
  CornerUpLeft,
  CornerUpRight,
  FileText,
  Search,
  Settings2,
  Share2,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Button, Card, EmptyState, Skeleton } from '@/ui/primitives';
import { Dialog, useToast } from '@/ui/overlay';
import { Field, Input, Select, Textarea } from '@/ui/form';
import { cn } from '@/ui/utils';
import { clockOf, dayKey, dayLabel } from './days';
import { MessageTrace } from './message-trace';
import { ANY_DAY, DateRangePicker, inRange, type DayRange } from '@/ui/date-range-picker';

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
  /** In the desk's list as a transfer to send, and how far it got. */
  request: { id: string; status: string } | null;
  /** What the bot read off it, for adding it to the list by hand. */
  suggested: {
    account: string;
    name: string | null;
    channel: string | null;
    amount: string;
    currency: string;
  } | null;
}


/**
 * The groups the bank desk follows, live: every message as WhatsApp shows it,
 * the deal a message is the announcement of and whether its transfer went, and
 * where each was passed on — by a rule or by a person. Any message can be passed
 * on from here, by the bot, to the groups chosen.
 */
export function GroupFeed() {
  const { t, locale } = useLocale();
  const toast = useToast();
  const [groups, setGroups] = useState<Group[] | null>(null);
  /** Which days of the group to show. */
  const [days, setDays] = useState<DayRange>(ANY_DAY);
  const [canChoose, setCanChoose] = useState(false);
  const [chat, setChat] = useState<string | null>(null);
  const [messages, setMessages] = useState<FeedMessage[] | null>(null);
  const [everyGroup, setEveryGroup] = useState<Group[] | null>(null);
  const [choosing, setChoosing] = useState<Group[] | null>(null);
  const [forwarding, setForwarding] = useState<{ message: FeedMessage; targets: Group[]; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  /** The message being followed through the groups. */
  const [tracing, setTracing] = useState<string | null>(null);
  /** The banks a request may name, and a message being added to the desk's list. */
  const [channels, setChannels] = useState<string[]>([]);
  const [adding, setAdding] = useState<{
    message: FeedMessage;
    account: string;
    name: string;
    channel: string;
    amount: string;
    currency: string;
  } | null>(null);
  /** Searching the group (on the server, across all kept), and showing only some kinds. */
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [show, setShow] = useState<'all' | 'waiting' | 'sent' | 'outside' | 'forwarded' | 'photos'>(
    'all',
  );
  // Asked of the server once typing pauses, not on every key.
  useEffect(() => {
    const timer = setTimeout(() => setSearched(query.trim()), 350);
    return () => clearTimeout(timer);
  }, [query]);

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
      const result = await api.get<{ groups: Group[]; canChoose: boolean; channels?: string[] }>(
        '/api/bank/groups',
      );
      setChannels(result.channels ?? []);
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
      setMessages(
        await api.get<FeedMessage[]>(
          `/api/bank/groups/feed?chat=${encodeURIComponent(chat)}${searched ? `&q=${encodeURIComponent(searched)}` : ''}`,
        ),
      );
    } catch {
      setMessages((current) => current ?? []);
    }
  }, [chat, searched]);

  const visible = (messages ?? []).filter((message) => {
    if (!inRange(dayKey(message.at), days)) return false;
    switch (show) {
      case 'waiting':
        return message.deal?.status === 'PENDING_TRANSFER';
      case 'sent':
        return Boolean(message.deal && message.deal.status !== 'PENDING_TRANSFER');
      case 'outside':
        return !message.fromMe && !message.deal;
      case 'forwarded':
        return message.forwardedTo.length > 0 || Boolean(message.forwardedFrom);
      case 'photos':
        return Boolean(message.mediaId);
      default:
        return true;
    }
  });

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

  const addToList = async () => {
    if (!adding) return;
    setBusy(true);
    try {
      await api.post('/api/bank/requests', {
        messageId: adding.message.id,
        account: adding.account.trim(),
        name: adding.name.trim() || null,
        channel: adding.channel || null,
        amount: adding.amount.trim(),
        currency: adding.currency,
      });
      toast.success(t('bankFeed.added'));
      setAdding(null);
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
    <Card className="flex h-[calc(100dvh-15rem)] min-h-[26rem] flex-col overflow-hidden p-0 xl:h-[78vh] xl:min-h-[28rem]">
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

      {/* --- Search the group, and show only what matters now --- */}
      {groups && groups.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-2 py-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-content-tertiary" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('bankFeed.search')}
              className="h-9 w-full rounded-full bg-surface-sunken ps-8 pe-3 text-sm text-content outline-none ring-1 ring-transparent focus:ring-primary"
            />
          </div>
          <DateRangePicker value={days} onChange={setDays} />
          <div className="flex gap-1 overflow-x-auto">
            {(['all', 'waiting', 'sent', 'outside', 'forwarded', 'photos'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={show === option}
                onClick={() => setShow(option)}
                className={cn(
                  'h-8 shrink-0 rounded-full px-3 text-xs font-semibold transition-colors',
                  show === option
                    ? 'bg-primary text-white'
                    : 'bg-surface-sunken text-content-secondary hover:text-content',
                )}
              >
                {t(`bankFeed.show.${option}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* --- The conversation --- */}
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto bg-surface-sunken px-2 py-2 sm:px-3">
        {groups !== null && groups.length === 0 ? (
          <EmptyState
            title={t('bankFeed.noGroupsTitle')}
            description={canChoose ? t('bankFeed.noGroupsManager') : t('bankFeed.noGroupsDesk')}
          />
        ) : messages === null ? (
          <Skeleton className="h-40" />
        ) : visible.length === 0 ? (
          searched || show !== 'all' || days.from || days.to ? (
            <EmptyState title={t('bankFeed.noMatch')} />
          ) : (
            <EmptyState title={t('bankFeed.emptyTitle')} description={t('bankFeed.emptyBody')} />
          )
        ) : (
          visible.map((message, index) => (
            <div key={message.id} className="contents">
            {/* A new day, as WhatsApp marks it. */}
            {dayKey(message.at) !== (index > 0 ? dayKey(visible[index - 1]!.at) : '') && (
              // One width and a solid face: the day held at the top hides the one before it whole, as WhatsApp does.
              <div className="sticky top-0 z-10 my-1 min-w-32 self-center rounded-full bg-surface px-3 py-0.5 text-center text-[11px] font-medium text-content-secondary shadow-[var(--shadow-sm)] ring-1 ring-border-subtle">
                {dayLabel(dayKey(message.at), locale, {
                  today: t('bank.period.today'),
                  yesterday: t('bank.period.yesterday'),
                })}
              </div>
            )}
            <div
              // Pressed anywhere but its buttons, a message opens its way through the groups.
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('a,button')) return;
                setTracing(message.id);
              }}
              title={t('bankFeed.traceTitle')}
              className={cn(
                'group max-w-[min(92%,24rem)] cursor-pointer rounded-xl px-2.5 py-1.5 text-[13px] leading-snug transition-shadow hover:ring-2 hover:ring-primary/40',
                message.fromMe
                  ? 'self-end bg-success-subtle text-content'
                  : 'self-start bg-surface text-content ring-1 ring-border-subtle',
                tracing === message.id && 'ring-2 ring-primary',
              )}
            >
              <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] font-semibold leading-4 text-primary-text">
                <span>{message.fromMe
                  ? t('bankFeed.office')
                  : (message.senderName ?? (message.senderPhone ? `+${message.senderPhone}` : t('bankFeed.member')))}</span>
  {!message.fromMe && message.senderPhone && message.senderName && (
                  <span className="font-normal text-content-tertiary ltr-content">+{message.senderPhone}</span>
                )}
                {message.deal ? (
                  <span className="rounded-full bg-success-subtle px-1.5 text-[10px] font-semibold text-success-text">
                    {t('bank.originSystem')}
                  </span>
                ) : (
                  !message.fromMe && (
                    <span className="rounded-full bg-warning-subtle px-1.5 text-[10px] font-semibold text-warning-text">
                      {t('bank.originExternal')}
                    </span>
                  )
                )}
              </p>
              {message.forwardedFrom && (
                <p className="flex items-center gap-1 text-[10px] text-content-tertiary">
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
                    className="my-0.5 max-h-44 rounded-lg object-contain"
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
              {/* Blank lines between a transfer's lines are spacing for the phone: dropped here, so more of the talk shows. */}
              {message.text && (
                <p className="whitespace-pre-wrap break-words">{message.text.replace(/\n[ \t]*(?:\n[ \t]*)+/g, '\n').trim()}</p>
              )}

              {/* The deal it announces, and whether its transfer went. */}
              {message.deal && (
                <Link
                  href={`/manage/transactions/${message.deal.id}`}
                  className={cn(
                    'me-1 mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-4',
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

              {/* In the desk's list: waiting, or sent. */}
              {message.request && message.request.status !== 'DISMISSED' && (
                <span
                  className={cn(
                    'me-1 mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-4',
                    message.request.status === 'SENT'
                      ? 'bg-success-subtle text-success-text'
                      : 'bg-warning-subtle text-warning-text',
                  )}
                >
                  {message.request.status === 'SENT' ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <ClipboardList className="size-3" />
                  )}
                  {message.request.status === 'SENT' ? t('bankFeed.requestSent') : t('bankFeed.inList')}
                </span>
              )}

              {/* Where it went from here. */}
              {message.forwardedTo.map((entry, index) => (
                <p key={index} className="mt-0.5 flex items-center gap-1 text-[10px] leading-4 text-content-tertiary">
                  <CornerUpRight className="size-3" />
                  {t('bankFeed.to', { group: entry.group })} ·{' '}
                  {entry.auto ? t('bankFeed.auto') : (entry.by ?? '')}
                </p>
              ))}

              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] tabular-nums text-content-tertiary ltr-content">{clockOf(message.at)}</span>
                <span className="flex items-center gap-1">
                {/* Someone else's message, not yet in the list: added by hand, from what the bot read. */}
                {!message.fromMe && (!message.request || message.request.status === 'DISMISSED') && (
                  <button
                    type="button"
                    onClick={() =>
                      setAdding({
                        message,
                        account: message.suggested?.account ?? '',
                        name: message.suggested?.name ?? '',
                        channel: message.suggested?.channel ?? channels[0] ?? '',
                        amount: message.suggested
                          ? String(Number(message.suggested.amount) / 1e8)
                          : '',
                        currency: message.suggested?.currency ?? 'ILS',
                      })
                    }
                    className="inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-5 text-warning-text hover:bg-warning-subtle"
                  >
                    <ClipboardList className="size-3" />
                    {t('bankFeed.addToList')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setForwarding({ message, targets: [], text: message.text });
                    void loadEveryGroup();
                  }}
                  className="inline-flex items-center gap-1 rounded-full px-1.5 text-[10px] font-medium leading-5 text-primary-text hover:bg-primary-subtle"
                >
                  <Share2 className="size-3" />
                  {t('bankFeed.forward')}
                </button>
                </span>
              </div>
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

      <MessageTrace id={tracing} onClose={() => setTracing(null)} onOpen={setTracing} />

      {/* --- A message added to the desk's list by hand --- */}
      <Dialog
        open={adding !== null}
        onClose={() => setAdding(null)}
        title={t('bankFeed.addTitle')}
        description={t('bankFeed.addHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAdding(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!adding?.account.trim() || !(Number(adding?.amount) > 0)}
              onClick={() => void addToList()}
            >
              {t('bankFeed.addToList')}
            </Button>
          </>
        }
      >
        {adding && (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap rounded-xl bg-surface-sunken p-3 text-xs text-content-secondary">
              {adding.message.text || '📎'}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('bank.account')} required>
                {(props) => (
                  <Input
                    {...props}
                    dir="ltr"
                    value={adding.account}
                    onChange={(event) => setAdding({ ...adding, account: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('bank.name')}>
                {(props) => (
                  <Input
                    {...props}
                    value={adding.name}
                    onChange={(event) => setAdding({ ...adding, name: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('bankFeed.channel')}>
                {(props) => (
                  <Select
                    {...props}
                    options={[
                      { value: '', label: '—' },
                      ...channels.map((entry) => ({ value: entry, label: entry })),
                    ]}
                    value={adding.channel}
                    onChange={(event) => setAdding({ ...adding, channel: event.target.value })}
                  />
                )}
              </Field>
              <div className="grid grid-cols-[1fr_6rem] gap-2">
                <Field label={t('bank.amount')} required>
                  {(props) => (
                    <Input
                      {...props}
                      dir="ltr"
                      inputMode="decimal"
                      value={adding.amount}
                      onChange={(event) => setAdding({ ...adding, amount: event.target.value })}
                    />
                  )}
                </Field>
                <Field label={t('bank.currency')}>
                  {(props) => (
                    <Select
                      {...props}
                      options={['ILS', 'USD', 'JOD', 'EUR'].map((code) => ({ value: code, label: code }))}
                      value={adding.currency}
                      onChange={(event) => setAdding({ ...adding, currency: event.target.value })}
                    />
                  )}
                </Field>
              </div>
            </div>
          </div>
        )}
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
