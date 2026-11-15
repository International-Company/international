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
  ExternalLink,
  ImagePlus,
  MessageSquarePlus,
  QrCode,
  Search,
  SendHorizontal,
  Smartphone,
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
  lastMessageAt: string;
  lastText: string;
  awaiting: boolean;
}

interface Message {
  id: string;
  role: 'customer' | 'bot' | 'staff';
  text: string;
  authorName: string | null;
  imageId?: string | null;
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

/**
 * One list of conversations and the one open beside it: the private number's,
 * which everyone with the inbox shares, or the teller's own number's, which is
 * theirs alone. `base` is where each is read and written.
 */
function Conversations({
  base,
  tabs,
  listTop,
}: {
  base: string;
  tabs: ReactNode;
  listTop?: ReactNode;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [query, setQuery] = useState('');
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [photo, setPhoto] = useState<{ data: string; preview: string } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
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
      const next = await api.get<ChatRow[]>(base);
      const waiting = new Set(next.filter((row) => row.awaiting).map((row) => row.id));
      const before = waitingBefore.current;
      if (before && [...waiting].some((id) => !before.has(id))) chime();
      waitingBefore.current = waiting;
      setRows(next);
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
        }),
      );
      setDraft('');
      setPhoto(null);
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
          <div className="flex flex-wrap items-center gap-2">
            {tabs}
            <Button
              icon={<MessageSquarePlus />}
              onClick={() => setFresh((current) => ({ ...current, open: true }))}
            >
              {t('inbox.newChat')}
            </Button>
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
          {listTop}
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
                    setPhoto(null);
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
                    {message.imageId && (
                      <a
                        href={`/api/inbox/images/${message.imageId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="-mx-1 -mt-0.5 mb-1 block"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/inbox/images/${message.imageId}`}
                          alt={t('inbox.photo')}
                          loading="lazy"
                          className="max-h-72 w-full rounded-xl object-cover"
                        />
                      </a>
                    )}
                    {message.text && (
                      <span className="whitespace-pre-wrap break-words">{message.text}</span>
                    )}
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

type Source = 'office' | 'mine';

interface Link {
  status: 'OFF' | 'CONNECTING' | 'WAITING_QR' | 'CONNECTED';
  qrImage: string | null;
  pairingCode: string | null;
  number: string | null;
  error: string | null;
}

export function InboxView() {
  const { t } = useLocale();
  const [source, setSource] = useState<Source>('office');

  useEffect(() => {
    try {
      if (window.localStorage.getItem('inbox.source') === 'mine') setSource('mine');
    } catch {
      // Remembering the tab is a nicety.
    }
  }, []);

  const choose = (next: Source) => {
    setSource(next);
    try {
      window.localStorage.setItem('inbox.source', next);
    } catch {
      // As above.
    }
  };

  const tabs = (
    <div role="tablist" className="flex gap-1 rounded-xl bg-surface-sunken p-1 text-sm">
      {(['office', 'mine'] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={source === id}
          onClick={() => choose(id)}
          className={`min-h-9 rounded-lg px-3 py-1.5 font-medium ${
            source === id ? 'bg-surface text-content shadow-sm' : 'text-content-secondary'
          }`}
        >
          {id === 'office' ? t('inbox.sourceOffice') : t('inbox.sourceMine')}
        </button>
      ))}
    </div>
  );

  return source === 'office' ? (
    <Conversations key="office" base="/api/inbox" tabs={tabs} />
  ) : (
    <Conversations key="mine" base="/api/inbox/mine" tabs={tabs} listTop={<MyNumber />} />
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
