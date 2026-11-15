'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ExternalLink, Search, SendHorizontal } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { useToast } from '@/ui/overlay';
import { Badge, Button, Card, CardBody, EmptyState, Skeleton } from '@/ui/primitives';
import { Input, Textarea } from '@/ui/form';

interface ChatRow {
  id: string;
  phone: string | null;
  lastMessageAt: string;
  lastText: string;
  awaiting: boolean;
}

interface Message {
  id: string;
  role: 'customer' | 'bot' | 'staff';
  text: string;
  authorName: string | null;
  createdAt: string;
}

interface Thread {
  id: string;
  phone: string | null;
  messages: Message[];
}

const when = (value: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  );

/** A short tone when someone new is waiting. Silent where the browser will not play it. */
function chime() {
  try {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const context = new Context();
    const tone = context.createOscillator();
    const level = context.createGain();
    tone.frequency.value = 880;
    level.gain.setValueAtTime(0.12, context.currentTime);
    level.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.35);
    tone.connect(level).connect(context.destination);
    tone.start();
    tone.stop(context.currentTime + 0.35);
    tone.onended = () => void context.close();
  } catch {
    // Sound is a nicety; the list shows who is waiting regardless.
  }
}

export function InboxView() {
  const { t } = useLocale();
  const toast = useToast();
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [query, setQuery] = useState('');
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const waitingBefore = useRef<Set<string> | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const failure = useCallback(
    (cause: unknown) =>
      toast.error(
        t('errors.title'),
        cause instanceof ApiError
          ? say(t, cause.messageKey, cause.params) || cause.message
          : t('errors.generic'),
      ),
    [toast, t],
  );

  const load = useCallback(async () => {
    try {
      const next = await api.get<ChatRow[]>('/api/inbox');
      const waiting = new Set(next.filter((row) => row.awaiting).map((row) => row.id));
      const before = waitingBefore.current;
      if (before && [...waiting].some((id) => !before.has(id))) chime();
      waitingBefore.current = waiting;
      setRows(next);
    } catch (cause) {
      failure(cause);
      setRows((current) => current ?? []);
    }
  }, [failure]);

  const read = useCallback(
    async (id: string) => {
      try {
        setThread(await api.get<Thread>(`/api/inbox/${id}`));
      } catch (cause) {
        failure(cause);
      }
    },
    [failure],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    void read(selected);
    const timer = setInterval(() => void read(selected), 4_000);
    return () => clearInterval(timer);
  }, [selected, read]);

  const lastId = thread?.messages.at(-1)?.id;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [lastId]);

  const waitingCount = rows?.filter((row) => row.awaiting).length ?? 0;
  useEffect(() => {
    const base = t('inbox.title');
    document.title = waitingCount > 0 ? `(${waitingCount}) ${base}` : base;
  }, [waitingCount, t]);

  const send = async () => {
    const text = draft.trim();
    if (!thread || !text || sending) return;
    setSending(true);
    try {
      setThread(await api.post<Thread>(`/api/inbox/${thread.id}`, { text }));
      setDraft('');
      void load();
    } catch (cause) {
      failure(cause);
    } finally {
      setSending(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter starts a new line, as in WhatsApp on a computer.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  if (!rows) return <Skeleton className="h-64 w-full" />;

  const digits = query.replace(/\D/g, '');
  const shown = rows.filter(
    (row) =>
      (!onlyWaiting || row.awaiting) &&
      (!digits || (row.phone ?? '').includes(digits)) &&
      (digits || !query.trim() || row.lastText.includes(query.trim())),
  );

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <Card className={selected ? 'hidden lg:block' : undefined}>
        <div className="space-y-2 border-b border-border-subtle p-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('inbox.search')}
            iconStart={<Search className="size-4" />}
          />
          <div className="flex gap-1 rounded-xl bg-surface-sunken p-1 text-sm">
            {[false, true].map((waiting) => (
              <button
                key={String(waiting)}
                type="button"
                aria-pressed={onlyWaiting === waiting}
                onClick={() => setOnlyWaiting(waiting)}
                className={`flex-1 rounded-lg px-2 py-1.5 font-medium ${
                  onlyWaiting === waiting
                    ? 'bg-surface text-content shadow-sm'
                    : 'text-content-secondary'
                }`}
              >
                {waiting ? t('inbox.waiting', { count: waitingCount }) : t('inbox.all')}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[65vh] overflow-y-auto">
          {shown.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-content-tertiary">
              {t('inbox.empty')}
            </p>
          ) : (
            shown.map((row) => (
              <button
                key={row.id}
                type="button"
                aria-pressed={selected === row.id}
                onClick={() => {
                  setSelected(row.id);
                  setThread(null);
                  setDraft('');
                }}
                className={`block w-full border-b border-border-subtle px-4 py-3 text-start transition-colors last:border-b-0 ${
                  selected === row.id ? 'bg-primary-subtle' : 'hover:bg-surface-sunken'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="ltr-content text-sm font-semibold tabular-nums text-content">
                    {row.phone ? `+${row.phone}` : t('inbox.phoneHidden')}
                  </span>
                  {row.awaiting && <Badge tone="warning">{t('inbox.awaiting')}</Badge>}
                </span>
                <span className="mt-1 block truncate text-xs text-content-secondary">
                  {row.lastText}
                </span>
                <span className="mt-1 block text-xs tabular-nums text-content-tertiary">
                  {when(row.lastMessageAt)}
                </span>
              </button>
            ))
          )}
        </div>
      </Card>

      <Card className={selected ? undefined : 'hidden lg:block'}>
        {!selected ? (
          <CardBody>
            <EmptyState title={t('inbox.choose')} />
          </CardBody>
        ) : !thread ? (
          <CardBody>
            <Skeleton className="h-64 w-full" />
          </CardBody>
        ) : (
          <CardBody className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="lg:hidden"
                  onClick={() => setSelected(null)}
                >
                  {t('inbox.back')}
                </Button>
                <p className="ltr-content text-sm font-semibold tabular-nums text-content">
                  {thread.phone ? `+${thread.phone}` : t('inbox.phoneHidden')}
                </p>
              </div>
              {thread.phone && (
                <a
                  href={`https://wa.me/${thread.phone}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-primary-text hover:bg-surface-sunken"
                >
                  <ExternalLink className="size-4" />
                  {t('inbox.openWhatsapp')}
                </a>
              )}
            </div>

            <div className="flex h-[55vh] flex-col gap-2 overflow-y-auto rounded-xl bg-surface-sunken p-3">
              {thread.messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                    message.role === 'customer'
                      ? 'self-start bg-surface text-content ring-1 ring-border-subtle'
                      : message.role === 'staff'
                        ? 'self-end bg-success-subtle text-content'
                        : 'self-end bg-primary-subtle text-content'
                  }`}
                >
                  <span className="block text-[11px] font-medium text-content-tertiary">
                    {message.role === 'staff' && message.authorName
                      ? message.authorName
                      : t(`inbox.role.${message.role}`)}{' '}
                    · <span className="tabular-nums">{when(message.createdAt)}</span>
                  </span>
                  <span className="whitespace-pre-wrap break-words">{message.text}</span>
                </div>
              ))}
              <div ref={bottom} />
            </div>

            <div className="flex items-end gap-2">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onKey}
                rows={2}
                maxLength={2000}
                placeholder={t('inbox.placeholder')}
                className="min-h-[2.75rem] flex-1 resize-none"
              />
              <Button
                icon={<SendHorizontal className="rtl:-scale-x-100" />}
                loading={sending}
                disabled={!draft.trim()}
                onClick={() => void send()}
              >
                {t('inbox.send')}
              </Button>
            </div>
            <p className="text-xs text-content-tertiary">{t('inbox.hint')}</p>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
