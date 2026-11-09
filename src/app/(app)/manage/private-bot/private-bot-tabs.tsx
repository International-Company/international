'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  ExternalLink,
  Inbox,
  MessagesSquare,
  Pause,
  Play,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { useToast } from '@/ui/overlay';
import { Badge, Button, Card, CardBody, EmptyState, Skeleton } from '@/ui/primitives';
import { PrivateBotView } from './private-bot-view';

type Tab = 'setup' | 'requests' | 'chats' | 'issues';
type Status = 'NEW' | 'IN_PROGRESS' | 'DONE';

interface BotRequest {
  id: string;
  summary: string;
  status: Status;
  handledByName: string | null;
  createdAt: string;
  phone: string | null;
  conversationId: string;
}

interface Issue {
  id: string;
  scope: string;
  title: string;
  action: string;
  detail: string;
  critical: boolean;
  count: number;
  firstAt: string;
  lastAt: string;
}

interface ChatRow {
  id: string;
  phone: string | null;
  lastMessageAt: string;
  lastText: string;
  paused: boolean;
}

interface Thread {
  id: string;
  phone: string | null;
  pausedUntil: string | null;
  messages: { id: string; role: 'customer' | 'bot' | 'staff'; text: string; createdAt: string }[];
}

const when = (value: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  );

const TONE: Record<Status, 'warning' | 'primary' | 'success'> = {
  NEW: 'warning',
  IN_PROGRESS: 'primary',
  DONE: 'success',
};

export function PrivateBotTabs({ canManage }: { canManage: boolean }) {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>('setup');
  const [openChat, setOpenChat] = useState<string | null>(null);
  const tabs = [
    { id: 'setup', label: t('privateBot.tabSetup'), Icon: Bot },
    { id: 'requests', label: t('privateBot.tabRequests'), Icon: Inbox },
    { id: 'chats', label: t('privateBot.tabChats'), Icon: MessagesSquare },
    { id: 'issues', label: t('privateBot.tabIssues'), Icon: AlertTriangle },
  ] as const;

  const failure = useFailure();
  const [issues, setIssues] = useState<Issue[]>([]);
  const loadIssues = useCallback(async () => {
    try {
      setIssues(await api.get<Issue[]>('/api/admin/private-bot/issues'));
    } catch {
      // Kept as it was; the next poll tries again.
    }
  }, []);

  useEffect(() => {
    void loadIssues();
    const timer = setInterval(() => void loadIssues(), 15_000);
    return () => clearInterval(timer);
  }, [loadIssues]);

  // Opened from the bell, straight to what it is about.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('tab') === 'issues') setTab('issues');
  }, []);

  const critical = issues.filter((issue) => issue.critical).length;

  return (
    <div className="space-y-4">
      {issues.length > 0 && tab !== 'issues' && (
        <button
          type="button"
          onClick={() => setTab('issues')}
          className={`flex w-full items-center gap-2 rounded-2xl px-4 py-3 text-start text-sm font-semibold ${
            critical > 0 ? 'bg-danger-subtle text-danger-text' : 'bg-warning-subtle text-warning-text'
          }`}
        >
          <AlertTriangle className="size-4 shrink-0" />
          {t('privateBot.issuesBanner', { count: issues.length })}
        </button>
      )}

      <div role="tablist" className="grid grid-cols-2 gap-1 rounded-2xl bg-surface-sunken p-1 sm:grid-cols-4">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`flex h-10 items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors ${
              tab === id
                ? 'bg-surface text-content shadow-[var(--shadow-sm)]'
                : 'text-content-secondary hover:text-content'
            }`}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{label}</span>
            {id === 'issues' && issues.length > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold text-white">
                {issues.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === 'setup' && <PrivateBotView canManage={canManage} />}
      {tab === 'requests' && (
        <Requests
          onOpenChat={(id) => {
            setOpenChat(id);
            setTab('chats');
          }}
        />
      )}
      {tab === 'chats' && <Chats initial={openChat} />}
      {tab === 'issues' && <Issues issues={issues} reload={loadIssues} onFailure={failure} />}
    </div>
  );
}

function useFailure() {
  const { t } = useLocale();
  const toast = useToast();
  return useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      ),
    [t, toast],
  );
}

function Issues({
  issues,
  reload,
  onFailure,
}: {
  issues: Issue[];
  reload: () => Promise<void>;
  onFailure: (cause: unknown) => void;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState<string | null>(null);

  const dismiss = async (id: string | null) => {
    setBusy(id ?? 'all');
    try {
      await api.delete(`/api/admin/private-bot/issues${id ? `/${id}` : ''}`);
      await reload();
    } catch (cause) {
      onFailure(cause);
    } finally {
      setBusy(null);
    }
  };

  if (issues.length === 0) {
    return <EmptyState title={t('privateBot.issuesEmpty')} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-content-secondary">{t('privateBot.issuesHint')}</p>
        <Button size="sm" variant="ghost" loading={busy === 'all'} onClick={() => void dismiss(null)}>
          {t('privateBot.issuesClear')}
        </Button>
      </div>
      {issues.map((issue) => (
        <Card key={issue.id}>
          <CardBody className="space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2">
                <AlertTriangle
                  className={`mt-0.5 size-4 shrink-0 ${issue.critical ? 'text-danger-text' : 'text-warning-text'}`}
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-content">{issue.title}</p>
                  <p className="mt-1 text-sm text-content-secondary">{issue.action}</p>
                </div>
              </div>
              <button
                type="button"
                aria-label={t('privateBot.issueDismiss')}
                title={t('privateBot.issueDismiss')}
                disabled={busy === issue.id}
                onClick={() => void dismiss(issue.id)}
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-content-tertiary transition-colors hover:bg-surface-sunken hover:text-content"
              >
                <X className="size-4" />
              </button>
            </div>
            <p className="text-xs text-content-tertiary">
              {t('privateBot.issueTimes', { count: issue.count })} ·{' '}
              <span className="tabular-nums">{when(issue.lastAt)}</span>
            </p>
            {issue.detail && (
              <p dir="ltr" className="break-words rounded-lg bg-surface-sunken px-2 py-1 text-start text-xs text-content-tertiary">
                {issue.detail}
              </p>
            )}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function Requests({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const { t } = useLocale();
  const failure = useFailure();
  const [rows, setRows] = useState<BotRequest[] | null>(null);
  const [filter, setFilter] = useState<Status | 'OPEN'>('OPEN');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<BotRequest[]>('/api/admin/private-bot/requests'));
    } catch (cause) {
      failure(cause);
      setRows([]);
    }
  }, [failure]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const move = async (id: string, status: Status) => {
    setBusy(id);
    try {
      await api.patch(`/api/admin/private-bot/requests/${id}`, { status });
      await load();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(null);
    }
  };

  if (!rows) return <Skeleton className="h-64 w-full" />;
  const shown = rows.filter((row) =>
    filter === 'OPEN' ? row.status !== 'DONE' : row.status === filter,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {(['OPEN', 'NEW', 'IN_PROGRESS', 'DONE'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={filter === option}
            onClick={() => setFilter(option)}
            className={`h-9 rounded-full px-3 text-sm font-medium transition-colors ${
              filter === option
                ? 'bg-primary-subtle text-primary-text ring-1 ring-primary'
                : 'bg-surface-sunken text-content-secondary'
            }`}
          >
            {t(`privateBot.filter.${option}`)}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <EmptyState title={t('privateBot.requestsEmpty')} />
      ) : (
        shown.map((row) => (
          <Card key={row.id}>
            <CardBody className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-content">{row.summary}</p>
                  <p className="mt-1 text-xs text-content-secondary">
                    <span className="ltr-content tabular-nums">
                      {row.phone ? `+${row.phone}` : t('privateBot.phoneHidden')}
                    </span>
                    {' · '}
                    <span className="tabular-nums">{when(row.createdAt)}</span>
                    {row.handledByName && ` · ${row.handledByName}`}
                  </p>
                </div>
                <Badge tone={TONE[row.status]}>{t(`privateBot.filter.${row.status}`)}</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                {row.status === 'NEW' && (
                  <Button size="sm" loading={busy === row.id} onClick={() => void move(row.id, 'IN_PROGRESS')}>
                    {t('privateBot.takeRequest')}
                  </Button>
                )}
                {row.status !== 'DONE' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Check />}
                    loading={busy === row.id}
                    onClick={() => void move(row.id, 'DONE')}
                  >
                    {t('privateBot.doneRequest')}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => void move(row.id, 'NEW')}>
                    {t('privateBot.reopenRequest')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => onOpenChat(row.conversationId)}>
                  {t('privateBot.viewChat')}
                </Button>
                {row.phone && (
                  <a
                    href={`https://wa.me/${row.phone}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-primary-text hover:bg-surface-sunken"
                  >
                    <ExternalLink className="size-4" />
                    {t('privateBot.openWhatsapp')}
                  </a>
                )}
              </div>
            </CardBody>
          </Card>
        ))
      )}
    </div>
  );
}

function Chats({ initial }: { initial: string | null }) {
  const { t } = useLocale();
  const failure = useFailure();
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initial);
  const [thread, setThread] = useState<Thread | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<ChatRow[]>('/api/admin/private-bot/conversations'));
    } catch (cause) {
      failure(cause);
      setRows([]);
    }
  }, [failure]);

  const read = useCallback(
    async (id: string) => {
      try {
        setThread(await api.get<Thread>(`/api/admin/private-bot/conversations/${id}`));
      } catch (cause) {
        failure(cause);
      }
    },
    [failure],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    void read(selected);
    const timer = setInterval(() => void read(selected), 10_000);
    return () => clearInterval(timer);
  }, [selected, read]);

  const pause = async (pauseMinutes: number | null) => {
    if (!thread) return;
    setBusy(true);
    try {
      setThread(
        await api.patch<Thread>(`/api/admin/private-bot/conversations/${thread.id}`, {
          pauseMinutes,
        }),
      );
      await load();
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
    }
  };

  if (!rows) return <Skeleton className="h-64 w-full" />;
  if (rows.length === 0) return <EmptyState title={t('privateBot.chatsEmpty')} />;
  const paused = thread?.pausedUntil && new Date(thread.pausedUntil) > new Date();

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <Card className="max-h-[70vh] overflow-y-auto">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            aria-pressed={selected === row.id}
            onClick={() => setSelected(row.id)}
            className={`block w-full border-b border-border-subtle px-4 py-3 text-start transition-colors last:border-b-0 ${
              selected === row.id ? 'bg-primary-subtle' : 'hover:bg-surface-sunken'
            }`}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="ltr-content text-sm font-semibold tabular-nums text-content">
                {row.phone ? `+${row.phone}` : t('privateBot.phoneHidden')}
              </span>
              {row.paused && <Badge tone="warning">{t('privateBot.pausedShort')}</Badge>}
            </span>
            <span className="mt-1 block truncate text-xs text-content-secondary">{row.lastText}</span>
            <span className="mt-1 block text-xs tabular-nums text-content-tertiary">
              {when(row.lastMessageAt)}
            </span>
          </button>
        ))}
      </Card>

      <Card>
        {!thread ? (
          <CardBody>
            <p className="py-16 text-center text-sm text-content-tertiary">
              {t('privateBot.chooseChat')}
            </p>
          </CardBody>
        ) : (
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="ltr-content text-sm font-semibold tabular-nums text-content">
                  {thread.phone ? `+${thread.phone}` : t('privateBot.phoneHidden')}
                </p>
                <p className="text-xs text-content-secondary">
                  {paused
                    ? t('privateBot.pausedUntil', { time: when(thread.pausedUntil!) })
                    : t('privateBot.botAnswering')}
                </p>
              </div>
              {paused ? (
                <Button size="sm" variant="secondary" icon={<Play />} loading={busy} onClick={() => void pause(null)}>
                  {t('privateBot.resume')}
                </Button>
              ) : (
                <Button size="sm" variant="secondary" icon={<Pause />} loading={busy} onClick={() => void pause(1440)}>
                  {t('privateBot.pause')}
                </Button>
              )}
            </div>
            <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto rounded-xl bg-surface-sunken p-3">
              {thread.messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                    message.role === 'customer'
                      ? 'self-start bg-surface text-content ring-1 ring-border-subtle'
                      : message.role === 'staff'
                        ? 'self-end bg-warning-subtle text-content'
                        : 'self-end bg-primary-subtle text-content'
                  }`}
                >
                  <span className="block text-[11px] font-medium text-content-tertiary">
                    {t(`privateBot.role.${message.role}`)} ·{' '}
                    <span className="tabular-nums">{when(message.createdAt)}</span>
                  </span>
                  <span className="whitespace-pre-wrap">{message.text}</span>
                </div>
              ))}
            </div>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
