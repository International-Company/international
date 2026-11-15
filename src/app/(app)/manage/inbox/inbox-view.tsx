'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ExternalLink, MessageSquarePlus, Search, SendHorizontal } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { Dialog, useToast } from '@/ui/overlay';
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '@/ui/primitives';
import { Field, Input, Textarea } from '@/ui/form';

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
  const [starting, setStarting] = useState(false);
  const [fresh, setFresh] = useState({ open: false, phone: '', text: '' });
  const waitingBefore = useRef<Set<string> | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // On a phone Enter is a new line, as in WhatsApp there; the button sends.
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    setTouch(window.matchMedia('(pointer: coarse)').matches);
  }, []);

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
    // The conversation scrolls inside its own box, never the page under it.
    const list = scroller.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lastId]);

  // The box grows with what is typed, up to a few lines, then scrolls.
  useEffect(() => {
    const field = box.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 140)}px`;
  }, [draft]);

  const waitingCount = rows?.filter((row) => row.awaiting).length ?? 0;
  useEffect(() => {
    const base = t('inbox.title');
    document.title = waitingCount > 0 ? `(${waitingCount}) ${base}` : base;
  }, [waitingCount, t]);

  const start = async () => {
    if (!fresh.phone.trim() || !fresh.text.trim() || starting) return;
    setStarting(true);
    try {
      const { id } = await api.post<{ id: string }>('/api/inbox', {
        phone: fresh.phone,
        text: fresh.text,
      });
      setFresh({ open: false, phone: '', text: '' });
      setThread(null);
      setSelected(id);
      void load();
    } catch (cause) {
      failure(cause);
    } finally {
      setStarting(false);
    }
  };

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
    if (touch) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const header = (
    // On a phone an open conversation takes the whole screen, title and all.
    <div className={selected ? 'hidden md:block' : undefined}>
      <PageHeader
        title={t('inbox.title')}
        description={t('inbox.subtitle')}
        actions={
          <Button
            icon={<MessageSquarePlus />}
            onClick={() => setFresh((current) => ({ ...current, open: true }))}
          >
            {t('inbox.newChat')}
          </Button>
        }
      />
    </div>
  );

  if (!rows) {
    return (
      <div className="space-y-4">
        {header}
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const digits = query.replace(/\D/g, '');
  const shown = rows.filter(
    (row) =>
      (!onlyWaiting || row.awaiting) &&
      (!digits || (row.phone ?? '').includes(digits)) &&
      (digits || !query.trim() || row.lastText.includes(query.trim())),
  );

  return (
    <div className="space-y-4">
      {header}
      <div className="grid gap-4 md:grid-cols-[17rem_minmax(0,1fr)] lg:grid-cols-[21rem_minmax(0,1fr)]">
        {/* The list: the whole page on a phone, a column beside the conversation from a tablet. */}
        <Card
          className={`${selected ? 'hidden' : 'flex'} flex-col overflow-hidden md:flex md:h-[calc(100dvh-13.5rem)] md:min-h-[24rem]`}
        >
          <div className="shrink-0 space-y-2 border-b border-border-subtle p-3">
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
                  className={`min-h-9 flex-1 rounded-lg px-2 py-1.5 font-medium ${
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
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
                    <span className="ltr-content truncate text-sm font-semibold tabular-nums text-content">
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

        {/* The conversation: under the top bar on a phone, beside the list from a tablet. */}
        <Card
          className={`${selected ? 'flex' : 'hidden md:flex'} h-[calc(100dvh-7.75rem)] min-h-[24rem] flex-col overflow-hidden md:h-[calc(100dvh-13.5rem)]`}
        >
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState title={t('inbox.choose')} />
            </div>
          ) : !thread ? (
            <div className="p-4">
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-2 py-2 sm:px-4">
                <button
                  type="button"
                  aria-label={t('inbox.back')}
                  onClick={() => setSelected(null)}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken md:hidden"
                >
                  <ArrowLeft className="size-5 rtl:-scale-x-100" />
                </button>
                <p className="min-w-0 flex-1 truncate text-start text-sm font-semibold text-content">
                  <span className="ltr-content tabular-nums">
                    {thread.phone ? `+${thread.phone}` : t('inbox.phoneHidden')}
                  </span>
                </p>
                {thread.phone && (
                  <a
                    href={`https://wa.me/${thread.phone}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('inbox.openWhatsapp')}
                    className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-primary-text hover:bg-surface-sunken"
                  >
                    <ExternalLink className="size-4" />
                    <span className="hidden sm:inline">{t('inbox.openWhatsapp')}</span>
                  </a>
                )}
              </div>

              <div
                ref={scroller}
                className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain bg-surface-sunken p-3"
              >
                {thread.messages.map((message) => (
                  <div
                    key={message.id}
                    className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm sm:max-w-[75%] ${
                      message.role === 'customer'
                        ? 'self-start bg-surface text-content ring-1 ring-border-subtle'
                        : message.role === 'staff'
                          ? 'self-end bg-success-subtle text-content'
                          : 'self-end bg-primary-subtle text-content'
                    }`}
                  >
                    <span className="whitespace-pre-wrap break-words">{message.text}</span>
                    <span className="mt-1 block text-[11px] text-content-tertiary">
                      {message.role === 'staff' && message.authorName
                        ? message.authorName
                        : t(`inbox.role.${message.role}`)}{' '}
                      · <span className="tabular-nums">{when(message.createdAt)}</span>
                    </span>
                  </div>
                ))}
              </div>

              <div className="shrink-0 space-y-1.5 border-t border-border-subtle p-2 sm:p-3">
                <div className="flex items-end gap-2">
                  <Textarea
                    ref={box}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onKey}
                    rows={1}
                    maxLength={2000}
                    enterKeyHint={touch ? 'enter' : 'send'}
                    placeholder={t('inbox.placeholder')}
                    className="min-h-11 flex-1 resize-none text-base sm:text-sm"
                  />
                  <Button
                    aria-label={t('inbox.send')}
                    icon={<SendHorizontal className="rtl:-scale-x-100" />}
                    loading={sending}
                    disabled={!draft.trim()}
                    onClick={() => void send()}
                    className="h-11 shrink-0"
                  >
                    <span className="hidden sm:inline">{t('inbox.send')}</span>
                  </Button>
                </div>
                <p className="hidden text-xs text-content-tertiary md:block">{t('inbox.hint')}</p>
              </div>
            </>
          )}
        </Card>
      </div>
      <Dialog
        open={fresh.open}
        onClose={() => setFresh((current) => ({ ...current, open: false }))}
        title={t('inbox.newChatTitle')}
        description={t('inbox.newChatHint')}
        footer={
          <Button
            icon={<SendHorizontal className="rtl:-scale-x-100" />}
            loading={starting}
            disabled={!fresh.phone.trim() || !fresh.text.trim()}
            onClick={() => void start()}
          >
            {t('inbox.newChatSend')}
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label={t('inbox.newChatPhone')} hint={t('inbox.newChatPhoneHint')} required>
            {(field) => (
              <Input
                {...field}
                dir="ltr"
                inputMode="tel"
                autoComplete="off"
                value={fresh.phone}
                onChange={(event) =>
                  setFresh((current) => ({ ...current, phone: event.target.value }))
                }
                className="text-start"
              />
            )}
          </Field>
          <Field label={t('inbox.newChatText')} required>
            {(field) => (
              <Textarea
                {...field}
                rows={4}
                maxLength={2000}
                value={fresh.text}
                onChange={(event) =>
                  setFresh((current) => ({ ...current, text: event.target.value }))
                }
              />
            )}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
