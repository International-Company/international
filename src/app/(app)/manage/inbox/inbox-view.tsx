'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  Eye,
  Users,
  Headset,
  ExternalLink,
  FileText,
  ImagePlus,
  MessageSquarePlus,
  Pencil,
  QrCode,
  Reply,
  Search,
  SendHorizontal,
  Smartphone,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { api, ApiError } from '@/lib/api-client';
import { say } from '@/lib/failure';
import { ConfirmDialog, Dialog, useToast } from '@/ui/overlay';
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from '@/ui/primitives';
import { Field, Input, Textarea } from '@/ui/form';
import { shrinkPhoto } from '@/ui/proof-photo';

interface ChatRow {
  id: string;
  phone: string | null;
  /** The customer's record name, else the name they go by on WhatsApp. */
  name: string | null;
  unread: number;
  lastMessageAt: string;
  lastText: string;
  awaiting: boolean;
  /** A group the number is in, rather than one person. */
  group?: boolean;
}

interface Message {
  id: string;
  role: 'customer' | 'bot' | 'staff';
  text: string;
  authorName: string | null;
  /** A file that came with it, and what kind. */
  imageId?: string | null;
  mediaKind?: 'image' | 'audio' | 'video' | 'document' | null;
  /** The message of the conversation it answered. */
  quotedId?: string | null;
  /** Whether it can be answered by quoting it. */
  quotable?: boolean;
  /** Its words were changed after it went; it was deleted for the customer. */
  edited?: boolean;
  deleted?: boolean;
  /** What may still be done to it: WhatsApp allows each only for a while. */
  editable?: boolean;
  deletable?: boolean;
  createdAt: string;
}

interface Thread {
  id: string;
  phone: string | null;
  name: string | null;
  group?: boolean;
  messages: Message[];
}

const phoneOf = (phone: string | null) => (phone ? `+${phone}` : null);

/** A file in a message: a photo to open, a sound or video to play, a document to save. */
function MediaView({ message }: { message: Message }) {
  const { t } = useLocale();
  const src = `/api/inbox/images/${message.imageId}`;
  switch (message.mediaKind) {
    case 'audio':
      return <audio controls preload="none" src={src} className="mb-1 h-10 w-64 max-w-full" />;
    case 'video':
      return (
        <video
          controls
          preload="metadata"
          src={src}
          className="-mx-1 -mt-0.5 mb-1 max-h-72 w-full rounded-xl bg-black"
        />
      );
    case 'document':
      return (
        <a
          href={src}
          className="mb-1 flex items-center gap-2 rounded-xl bg-surface-sunken px-3 py-2 text-sm font-medium text-primary-text hover:underline"
        >
          <FileText className="size-5 shrink-0" />
          {t('inbox.document')}
        </a>
      );
    default:
      return (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="-mx-1 -mt-0.5 mb-1 block"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={t('inbox.photo')}
            loading="lazy"
            className="max-h-72 w-full rounded-xl object-cover"
          />
        </a>
      );
  }
}

/** A quoted message, as WhatsApp shows one above an answer. */
function QuoteLine({ message, onClose }: { message: Message | null; onClose?: () => void }) {
  const { t } = useLocale();
  return (
    <div className="mb-1 flex items-start gap-2 rounded-lg border-s-4 border-primary bg-surface-sunken/80 px-2 py-1 text-xs">
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-primary-text">
          {message ? t(`inbox.role.${message.role}`) : t('inbox.quoteEarlier')}
        </span>
        {message && (
          <span className="line-clamp-2 text-content-secondary">
            {message.text || (message.mediaKind ? t(`inbox.kind.${message.mediaKind}`) : '')}
          </span>
        )}
      </span>
      {onClose && (
        <button
          type="button"
          aria-label={t('inbox.quoteCancel')}
          onClick={onClose}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

const when = (value: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  );

/**
 * One list of conversations and the one open beside it: the private number's,
 * which everyone with the inbox shares, or the teller's own number's, which is
 * theirs alone. `base` is where each is read and written.
 */
function Conversations({
  base,
  tabs,
  listTop,
  hint,
  readOnly = false,
}: {
  base: string;
  tabs: ReactNode;
  listTop?: ReactNode;
  /** What an answer from here does, under the box. */
  hint: string;
  /** Watching another number: read, never answered from here. */
  readOnly?: boolean;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [query, setQuery] = useState('');
  /** The list: every conversation, those waiting on an answer, or the groups. */
  const [listView, setListView] = useState<'all' | 'waiting' | 'groups'>('all');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [photo, setPhoto] = useState<{ data: string; preview: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [starting, setStarting] = useState(false);
  const [fresh, setFresh] = useState({ open: false, phone: '', text: '' });
  const [quote, setQuote] = useState<Message | null>(null);
  /** A sent message being put right: its new words, or about to be deleted. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<Message | null>(null);
  const [changing, setChanging] = useState(false);
  /** Everyone else in a customer's conversation right now, by the customer's number. */
  const [busy, setBusy] = useState<Map<string, { name: string; typing: boolean }>>(new Map());
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
      setRows(await api.get<ChatRow[]>(base));
    } catch (cause) {
      failure(cause);
      setRows((current) => current ?? []);
    }
  }, [failure, base]);

  const read = useCallback(
    async (id: string) => {
      try {
        setThread(await api.get<Thread>(`${base}/${id}`));
      } catch (cause) {
        failure(cause);
      }
    },
    [failure, base],
  );

  const readBusy = useCallback((list: { phone: string; name: string; typing: boolean }[]) => {
    const map = new Map<string, { name: string; typing: boolean }>();
    for (const entry of list) {
      const known = map.get(entry.phone);
      // Two in one conversation: whoever is typing is the one to say.
      if (!known || entry.typing) map.set(entry.phone, { name: entry.name, typing: entry.typing });
    }
    setBusy(map);
  }, []);

  // Who is where: asked every few seconds, so a taken conversation shows before it is answered twice.
  useEffect(() => {
    const ask = () =>
      void api
        .get<{ phone: string; name: string; typing: boolean }[]>('/api/inbox/presence')
        .then(readBusy)
        .catch(() => undefined);
    ask();
    const timer = setInterval(() => {
      if (!document.hidden) ask();
    }, 6_000);
    return () => clearInterval(timer);
  }, [readBusy]);

  /*
   * This conversation is open here: said to the others while it is, and whether
   * an answer is being typed. Watching another's number says nothing — the
   * watcher answers no one.
   */
  const openPhone = !readOnly && selected && thread?.id === selected ? thread.phone : null;
  const typingNow = draft.trim().length > 0 || photo !== null;
  useEffect(() => {
    if (readOnly) return;
    const say = () =>
      void api
        .post<{ phone: string; name: string; typing: boolean }[]>('/api/inbox/presence', {
          phone: openPhone,
          typing: Boolean(openPhone) && typingNow,
        })
        .then(readBusy)
        .catch(() => undefined);
    say();
    if (!openPhone) return;
    const timer = setInterval(() => {
      if (!document.hidden) say();
    }, 15_000);
    return () => clearInterval(timer);
  }, [readOnly, openPhone, typingNow, readBusy]);
  // Leaving the page leaves the conversation.
  useEffect(() => {
    if (readOnly) return;
    return () => {
      void api.post('/api/inbox/presence', { phone: null, typing: false }).catch(() => undefined);
    };
  }, [readOnly]);

  useEffect(() => {
    void load();
    // A tab nobody is looking at asks nothing; it catches up when it is shown.
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10_000);
    const shown = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    void read(selected);
    const timer = setInterval(() => {
      if (!document.hidden) void read(selected);
    }, 5_000);
    return () => clearInterval(timer);
  }, [selected, read]);

  const lastId = thread?.messages.at(-1)?.id;
  useEffect(() => {
    // The conversation scrolls inside its own box, never the page under it. Photos
    // load after it is drawn and push the end down, so it is followed once more.
    const toEnd = () => {
      const list = scroller.current;
      if (list) list.scrollTop = list.scrollHeight;
    };
    toEnd();
    const later = [setTimeout(toEnd, 400), setTimeout(toEnd, 1500)];
    return () => later.forEach(clearTimeout);
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
      const { id } = await api.post<{ id: string }>(base, {
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

  /** A photo pasted into the box, as WhatsApp takes one. Words pasted are left as they are. */
  const pastePhoto = (event: { clipboardData: DataTransfer | null; preventDefault: () => void }) => {
    const file = [...(event.clipboardData?.files ?? [])].find((entry) => entry.type.startsWith('image/'));
    if (!file) return;
    event.preventDefault();
    void choosePhoto(file);
  };

  const choosePhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      // Shrunk here, as every photo in the system is, before it is sent or kept.
      const data = await shrinkPhoto(file);
      setPhoto({ data, preview: `data:image/jpeg;base64,${data}` });
    } catch {
      toast.error(t('errors.title'), t('errors.proofImageInvalid'));
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!thread || (!text && !photo) || sending) return;
    setSending(true);
    try {
      setThread(
        await api.post<Thread>(`${base}/${thread.id}`, {
          text,
          ...(photo ? { image: photo.data } : {}),
          ...(quote ? { quoteId: quote.id } : {}),
        }),
      );
      setDraft('');
      setPhoto(null);
      setQuote(null);
      void load();
    } catch (cause) {
      failure(cause);
    } finally {
      setSending(false);
    }
  };

  const change = async (body: { messageId: string; text: string } | { messageId: string; delete: true }) => {
    if (!thread || changing) return;
    setChanging(true);
    try {
      setThread(await api.patch<Thread>(`${base}/${thread.id}`, body));
      setEditing(null);
      setDeleting(null);
      void load();
    } catch (cause) {
      failure(cause);
    } finally {
      setChanging(false);
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
          <div className="flex flex-wrap items-center gap-2">
            {tabs}
            {readOnly ? (
              <Badge tone="warning">
                <Eye className="me-1 inline size-3.5" />
                {t('inbox.watchReadOnly')}
              </Badge>
            ) : (
              <Button
                icon={<MessageSquarePlus />}
                onClick={() => setFresh((current) => ({ ...current, open: true }))}
              >
                {t('inbox.newChat')}
              </Button>
            )}
          </div>
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
  const words = query.trim();
  const shown = rows.filter(
    (row) =>
      (listView !== 'waiting' || row.awaiting) &&
      (listView !== 'groups' || row.group) &&
      (!digits || (row.phone ?? '').includes(digits)) &&
      (digits || !words || row.lastText.includes(words) || (row.name ?? '').includes(words)),
  );

  return (
    <div className="space-y-4">
      {header}
      <div className="grid gap-4 md:grid-cols-[17rem_minmax(0,1fr)] lg:grid-cols-[21rem_minmax(0,1fr)]">
        {/* The list: the whole page on a phone, a column beside the conversation from a tablet. */}
        <Card
          className={`${selected ? 'hidden' : 'flex'} flex-col overflow-hidden md:flex md:h-[calc(100dvh-13.5rem)] md:min-h-[24rem]`}
        >
          {listTop}
          <div className="shrink-0 space-y-2 border-b border-border-subtle p-3">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('inbox.search')}
              iconStart={<Search className="size-4" />}
            />
            <div className="flex gap-1 rounded-xl bg-surface-sunken p-1 text-sm">
              {(['all', 'waiting', ...(rows.some((row) => row.group) ? (['groups'] as const) : [])] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={listView === view}
                  onClick={() => setListView(view)}
                  className={`min-h-9 flex-1 rounded-lg px-2 py-1.5 font-medium ${
                    listView === view
                      ? 'bg-surface text-content shadow-sm'
                      : 'text-content-secondary'
                  }`}
                >
                  {view === 'waiting'
                    ? t('inbox.waiting', { count: waitingCount })
                    : view === 'groups'
                      ? t('inbox.groups')
                      : t('inbox.all')}
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
                    setPhoto(null);
                    setQuote(null);
                  }}
                  className={`block w-full border-b border-border-subtle px-4 py-3 text-start transition-colors last:border-b-0 ${
                    selected === row.id ? 'bg-primary-subtle' : 'hover:bg-surface-sunken'
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold text-content">
                      {row.group && <Users className="size-4 shrink-0 text-primary-text" aria-label={t('inbox.group')} />}
                      {row.name ?? (
                        <span className="ltr-content tabular-nums">
                          {phoneOf(row.phone) ?? t('inbox.phoneHidden')}
                        </span>
                      )}
                    </span>
                    {busy.get(row.phone ?? '') ? (
                      <span
                        className="inline-flex max-w-[9rem] shrink-0 items-center gap-1 truncate rounded-full bg-warning-subtle px-2 py-0.5 text-[11px] font-semibold text-warning-text"
                        title={t('inbox.busyWith', { name: busy.get(row.phone ?? '')!.name })}
                      >
                        <Headset className="size-3 shrink-0" />
                        <span className="truncate">
                          {busy.get(row.phone ?? '')!.typing
                            ? t('inbox.busyTyping', { name: busy.get(row.phone ?? '')!.name })
                            : busy.get(row.phone ?? '')!.name}
                        </span>
                      </span>
                    ) : row.unread > 0 ? (
                      <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-success px-1.5 text-[11px] font-bold leading-5 text-white tabular-nums">
                        {row.unread > 99 ? '99+' : row.unread}
                      </span>
                    ) : (
                      row.awaiting && <Badge tone="warning">{t('inbox.awaiting')}</Badge>
                    )}
                  </span>
                  {row.name && row.phone && (
                    <span className="mt-0.5 block text-[11px] text-content-tertiary">
                      <span className="ltr-content inline-block tabular-nums">
                        {phoneOf(row.phone)}
                      </span>
                    </span>
                  )}
                  <span
                    className={`mt-1 block truncate text-xs ${
                      row.unread > 0 ? 'font-semibold text-content' : 'text-content-secondary'
                    }`}
                  >
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
                <div className="min-w-0 flex-1 text-start">
                  <p className="truncate text-sm font-semibold text-content">
                    {thread.name ?? (
                      <span className="ltr-content tabular-nums">
                        {phoneOf(thread.phone) ?? t('inbox.phoneHidden')}
                      </span>
                    )}
                  </p>
                  {thread.name && thread.phone && (
                    <p className="text-xs text-content-tertiary">
                      <span className="ltr-content inline-block tabular-nums">
                        {phoneOf(thread.phone)}
                      </span>
                    </p>
                  )}
                </div>
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

              {busy.get(thread.phone ?? '') && (
                <p className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning-subtle px-3 py-2 text-xs font-semibold text-warning-text">
                  <Headset className="size-4 shrink-0" />
                  {busy.get(thread.phone ?? '')!.typing
                    ? t('inbox.busyTypingLong', { name: busy.get(thread.phone ?? '')!.name })
                    : t('inbox.busyWith', { name: busy.get(thread.phone ?? '')!.name })}
                </p>
              )}
              <div
                ref={scroller}
                className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain bg-surface-sunken p-3"
              >
                {thread.messages.map((message) => (
                  <div
                    key={message.id}
                    className={`group max-w-[88%] rounded-2xl px-3 py-2 text-sm sm:max-w-[75%] ${
                      message.role === 'customer'
                        ? 'self-start bg-surface text-content ring-1 ring-border-subtle'
                        : message.role === 'staff'
                          ? 'self-end bg-success-subtle text-content'
                          : 'self-end bg-primary-subtle text-content'
                    }`}
                  >
                    {message.quotedId !== undefined && message.quotedId !== null && (
                      <QuoteLine
                        message={
                          thread.messages.find((other) => other.id === message.quotedId) ?? null
                        }
                      />
                    )}
                    {message.imageId && <MediaView message={message} />}
                    {message.deleted ? (
                      <span className="italic text-content-tertiary">🚫 {t('inbox.deleted')}</span>
                    ) : (
                      message.text && (
                        <span className="whitespace-pre-wrap break-words">{message.text}</span>
                      )
                    )}
                    <span className="mt-1 flex items-center gap-1 text-[11px] text-content-tertiary">
                      <span className="min-w-0 flex-1">
                        {message.authorName
                          ? message.authorName
                          : t(`inbox.role.${message.role}`)}{' '}
                        · <span className="tabular-nums">{when(message.createdAt)}</span>
                        {message.edited && !message.deleted && <> · {t('inbox.edited')}</>}
                      </span>
                      {!readOnly && message.editable && (
                        <button
                          type="button"
                          aria-label={t('inbox.edit')}
                          title={t('inbox.edit')}
                          onClick={() => setEditing({ id: message.id, text: message.text })}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      )}
                      {!readOnly && message.deletable && (
                        <button
                          type="button"
                          aria-label={t('inbox.delete')}
                          title={t('inbox.delete')}
                          onClick={() => setDeleting(message)}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-danger-text sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                      {!readOnly && message.quotable && (
                        <button
                          type="button"
                          aria-label={t('inbox.quote')}
                          title={t('inbox.quote')}
                          onClick={() => {
                            setQuote(message);
                            box.current?.focus();
                          }}
                          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                        >
                          <Reply className="size-3.5" />
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>

              {readOnly ? (
                <p className="flex shrink-0 items-center justify-center gap-1.5 border-t border-border-subtle bg-warning-subtle/40 p-3 text-xs font-medium text-warning-text">
                  <Eye className="size-4" />
                  {t('inbox.watchNoAnswer')}
                </p>
              ) : (
              <div className="shrink-0 space-y-1.5 border-t border-border-subtle p-2 sm:p-3">
                {quote && <QuoteLine message={quote} onClose={() => setQuote(null)} />}
                {photo && (
                  <div className="relative inline-block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photo.preview}
                      alt={t('inbox.photo')}
                      className="h-24 rounded-xl object-cover ring-1 ring-border-subtle"
                    />
                    <button
                      type="button"
                      aria-label={t('inbox.photoRemove')}
                      onClick={() => setPhoto(null)}
                      className="absolute -end-2 -top-2 inline-flex size-7 items-center justify-center rounded-full bg-surface text-content shadow ring-1 ring-border-subtle"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <input
                    ref={picker}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      void choosePhoto(event.target.files?.[0]);
                      event.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    aria-label={t('inbox.photoAdd')}
                    title={t('inbox.photoAdd')}
                    onClick={() => picker.current?.click()}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-content-secondary ring-1 ring-border-subtle hover:bg-surface-sunken"
                  >
                    <ImagePlus className="size-5" />
                  </button>
                  <Textarea
                    ref={box}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onKey}
                    onPaste={pastePhoto}
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
                    disabled={!draft.trim() && !photo}
                    onClick={() => void send()}
                    className="h-11 shrink-0"
                  >
                    <span className="hidden sm:inline">{t('inbox.send')}</span>
                  </Button>
                </div>
                <p className="hidden text-xs text-content-tertiary md:block">
                  {hint} {t('inbox.pasteHint')}
                </p>
              </div>
              )}
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
      {/* --- A sent message, put right for the customer too --------------- */}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={t('inbox.editTitle')}
        description={t('inbox.editHint')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)} disabled={changing}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={changing}
              disabled={!editing?.text.trim()}
              onClick={() =>
                editing && void change({ messageId: editing.id, text: editing.text.trim() })
              }
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <Field label={t('inbox.message')}>
          {(props) => (
            <Textarea
              {...props}
              rows={4}
              value={editing?.text ?? ''}
              onChange={(event) => editing && setEditing({ ...editing, text: event.target.value })}
            />
          )}
        </Field>
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && void change({ messageId: deleting.id, delete: true })}
        title={t('inbox.deleteTitle')}
        message={t('inbox.deleteHint')}
        confirmLabel={t('inbox.delete')}
        cancelLabel={t('common.cancel')}
        loading={changing}
      />
    </div>
  );
}

interface Link {
  status: 'OFF' | 'CONNECTING' | 'WAITING_QR' | 'CONNECTED';
  qrImage: string | null;
  pairingCode: string | null;
  number: string | null;
  error: string | null;
}

/**
 * Each person's own number, answered from here. The office's private number is
 * the bot's now: its conversations are not offered here.
 */
interface Watched {
  numbers: { id: string; nameAr: string; nameEn: string; chats: number; unread: number }[];
  private: { chats: number; unread: number };
}

/**
 * The customer inbox: one's own number, answered from here. Whoever watches the
 * office's conversations also reads each person's number and the private one —
 * chosen at the top, and never answered from here, nor marked read for them.
 */
export function InboxView({ canWatch = false }: { canWatch?: boolean }) {
  const { t, locale } = useLocale();
  const [view, setView] = useState('mine');
  const [watched, setWatched] = useState<Watched | null>(null);

  useEffect(() => {
    if (!canWatch) return;
    const read = () =>
      void api
        .get<Watched>('/api/inbox/watch')
        .then(setWatched)
        .catch(() => undefined);
    read();
    const timer = setInterval(() => {
      if (!document.hidden) read();
    }, 60_000);
    return () => clearInterval(timer);
  }, [canWatch]);

  const picker = canWatch ? (
    <label className="flex h-10 items-center gap-2 rounded-xl bg-surface-sunken px-3 ring-1 ring-border-subtle">
      <Eye className="size-4 shrink-0 text-content-tertiary" />
      <span className="sr-only">{t('inbox.watchWhose')}</span>
      <select
        value={view}
        onChange={(event) => setView(event.target.value)}
        className="h-full min-w-0 bg-transparent text-sm font-semibold text-content outline-none"
      >
        <option value="mine">{t('inbox.watchMine')}</option>
        <option value="private">
          {t('inbox.watchPrivate')}
          {watched?.private.unread ? ` (${watched.private.unread})` : ''}
        </option>
        {(watched?.numbers ?? []).map((number) => (
          <option key={number.id} value={number.id}>
            {(locale === 'ar' ? number.nameAr : number.nameEn) +
              ` · ${t('inbox.watchChats', { count: number.chats })}` +
              (number.unread ? ` (${number.unread})` : '')}
          </option>
        ))}
      </select>
    </label>
  ) : null;

  if (view === 'mine') {
    return (
      <Conversations
        key="mine"
        base="/api/inbox/mine"
        tabs={picker}
        listTop={<MyNumber />}
        hint={t('inbox.hintMine')}
      />
    );
  }
  return (
    <Conversations
      key={view}
      base={`/api/inbox/watch/${view}`}
      tabs={picker}
      hint=""
      readOnly
    />
  );
}

/** The teller's own number: linked by scanning a QR, shown while it is, unlinked from here. */
function MyNumber() {
  const { t } = useLocale();
  const toast = useToast();
  const [link, setLink] = useState<Link | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [byNumber, setByNumber] = useState(false);
  const [phone, setPhone] = useState('');

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

  const read = useCallback(async () => {
    try {
      setLink(await api.get<Link>('/api/inbox/mine/link'));
    } catch (cause) {
      failure(cause);
    }
  }, [failure]);

  // Quick while a QR waits or the link comes up; slow once it is settled.
  const settled = link?.status === 'CONNECTED' || link?.status === 'OFF';
  useEffect(() => {
    void read();
    const timer = setInterval(
      () => {
        if (!document.hidden) void read();
      },
      settled ? 30_000 : 2_000,
    );
    return () => clearInterval(timer);
  }, [read, settled]);

  const act = async (action: 'start' | 'unlink', withPhone?: string) => {
    setBusy(true);
    try {
      setLink(
        await api.post<Link>('/api/inbox/mine/link', {
          action,
          ...(withPhone ? { phone: withPhone } : {}),
        }),
      );
    } catch (cause) {
      failure(cause);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  if (!link) return null;

  if (link.status === 'CONNECTED') {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-success-subtle/50 px-3 py-2 text-sm">
        <Smartphone className="size-4 shrink-0 text-success-text" />
        <span className="min-w-0 flex-1 truncate">
          {t('inbox.mineLinked')}{' '}
          <span className="ltr-content font-semibold tabular-nums">+{link.number}</span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Unlink />}
          aria-label={t('inbox.mineUnlink')}
          onClick={() => setConfirming(true)}
        />
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={() => void act('unlink')}
          title={t('inbox.mineUnlink')}
          message={t('inbox.mineUnlinkHint')}
          confirmLabel={t('inbox.mineUnlink')}
          cancelLabel={t('common.cancel')}
          tone="danger"
          loading={busy}
        />
      </div>
    );
  }

  const code = link.pairingCode;
  const waiting = link.status === 'WAITING_QR';
  const toggle = (
    <button
      type="button"
      onClick={() => setByNumber((current) => !current)}
      className="block w-full text-sm font-medium text-primary-text hover:underline"
    >
      {byNumber ? t('inbox.mineByQr') : t('inbox.mineByNumber')}
    </button>
  );

  // The code WhatsApp gave for the number: typed on the phone, it links.
  if (waiting && code) {
    return (
      <div className="shrink-0 space-y-3 border-b border-border-subtle p-4 text-center">
        <p className="text-sm text-content-secondary">{t('inbox.minePairCodeIs')}</p>
        <p
          dir="ltr"
          className="select-all font-mono text-3xl font-bold tracking-[0.2em] text-content"
        >
          {code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code}
        </p>
        <p className="text-sm text-content-secondary">{t('inbox.minePairSteps')}</p>
      </div>
    );
  }

  if (link.status === 'CONNECTING') {
    return (
      <div className="shrink-0 border-b border-border-subtle p-4 text-center">
        <p className="py-6 text-sm text-content-secondary">{t('inbox.mineConnecting')}</p>
      </div>
    );
  }

  return (
    <div className="shrink-0 space-y-3 border-b border-border-subtle p-4 text-center">
      {!waiting && <p className="text-sm text-content-secondary">{t('inbox.mineIntro')}</p>}
      {link.error === 'loggedOut' && !waiting && (
        <p className="text-xs text-warning-text">{t('inbox.mineLoggedOut')}</p>
      )}
      {link.error === 'pairFailed' && (
        <p className="text-xs text-warning-text">{t('inbox.minePairFailed')}</p>
      )}
      {byNumber ? (
        <div className="space-y-2 text-start">
          <Input
            dir="ltr"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+970599123456"
            aria-label={t('inbox.minePhone')}
          />
          <p className="text-xs text-content-tertiary">{t('inbox.minePhoneHint')}</p>
          <Button
            fullWidth
            icon={<Smartphone />}
            loading={busy}
            disabled={phone.replace(/\D/g, '').length < 8}
            onClick={() => void act('start', phone)}
          >
            {t('inbox.minePairGet')}
          </Button>
        </div>
      ) : waiting && link.qrImage ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={link.qrImage}
            alt={t('inbox.mineQrAlt')}
            className="mx-auto size-56 rounded-xl bg-white p-2"
          />
          <p className="text-sm text-content-secondary">{t('inbox.mineScan')}</p>
        </>
      ) : (
        <Button icon={<QrCode />} loading={busy} onClick={() => void act('start')}>
          {t('inbox.mineLink')}
        </Button>
      )}
      {toggle}
    </div>
  );
}
