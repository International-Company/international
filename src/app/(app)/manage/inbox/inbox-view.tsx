'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  BadgeDollarSign,
  ChevronDown,
  ChevronUp,
  Copy,
  Archive,
  Forward,
  MoreVertical,
  Pin,
  Tag,
  Zap,
  Smile,
  SmilePlus,
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
import { checkingLate, NoticePanel, STATUS_STYLE, type NoticeLine } from './notice-panel';
import {
  Avatar,
  clockOf,
  colourOf,
  dayChip,
  dayKeyOf,
  EMOJIS,
  EmojiSheet,
  Lightbox,
  listTime,
  Marked,
  QUICK_REACTIONS,
  Ticks,
} from './chat-ui';
import {
  ChatMenu,
  fillReply,
  LabelsDialog,
  matchReplies,
  RepliesDialog,
  ReplyPicker,
  type ChatMark,
  type Organisation,
  type QuickReply,
} from './organise-ui';

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
  /** The last message was ours, and how far it got. */
  lastFromMe?: boolean;
  lastAck?: number | null;
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
  /** One of ours: how far it got — 2 sent, 3 delivered, 4 read. */
  ack?: number | null;
  /** The reactions on it, and whether one can be put. */
  reactions?: { emoji: string; count: number; mine: boolean }[];
  reactable?: boolean;
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
function MediaView({ message, onOpen }: { message: Message; onOpen: (src: string) => void }) {
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
          className="mb-1 flex items-center gap-2 rounded-md bg-black/5 px-3 py-2.5 text-sm font-medium hover:underline dark:bg-white/5"
        >
          <FileText className="size-5 shrink-0" />
          {t('inbox.document')}
        </a>
      );
    default:
      return (
        <button type="button" onClick={() => onOpen(src)} className="-mx-1 -mt-0.5 mb-1 block w-[calc(100%+0.5rem)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={t('inbox.photo')}
            loading="lazy"
            className="max-h-80 w-full min-w-[12rem] rounded-md object-cover"
          />
        </button>
      );
  }
}

/** A quoted message, as WhatsApp shows one above an answer. */
function QuoteLine({ message, onClose }: { message: Message | null; onClose?: () => void }) {
  const { t } = useLocale();
  return (
    <div
      className="mb-1 flex items-start gap-2 rounded-md border-s-4 bg-black/5 px-2 py-1 text-xs dark:bg-white/5"
      style={{ borderInlineStartColor: colourOf(message?.authorName ?? message?.role ?? '') }}
    >
      <span className="min-w-0 flex-1">
        <span className="block font-semibold" style={{ color: colourOf(message?.authorName ?? message?.role ?? '') }}>
          {message ? (message.authorName ?? t(`inbox.role.${message.role}`)) : t('inbox.quoteEarlier')}
        </span>
        {message && (
          <span className="line-clamp-2 wa-meta">
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
  groupsApi,
  notices: withNotices = false,
  canShare = false,
}: {
  base: string;
  tabs: ReactNode;
  listTop?: ReactNode;
  /** What an answer from here does, under the box. */
  hint: string;
  /** Watching another number: read, never answered from here. */
  readOnly?: boolean;
  /** Where the number's groups are listed and followed, when it has any to offer. */
  groupsApi?: string;
  /** Remittance notices taken from the conversations and checked with agents: one's own number only. */
  notices?: boolean;
  /** May offer a quick reply to the whole office. */
  canShare?: boolean;
}) {
  const { t } = useLocale();
  const toast = useToast();
  const { locale } = useLocale();
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [query, setQuery] = useState('');
  /** The list: every conversation, those waiting on an answer, or the groups. */
  /** The list: people, people waiting on an answer, or the groups — never the two mixed. */
  const [listView, setListView] = useState<'people' | 'waiting' | 'groups' | 'notices'>('people');
  /** The remittance notices, and the one open beside the conversation. */
  const [noticeRows, setNoticeRows] = useState<NoticeLine[]>([]);
  const [activeNotice, setActiveNotice] = useState<string | null>(null);
  const [noticeNow, setNoticeNow] = useState(() => Date.now());
  const loadNotices = useCallback(async () => {
    if (!withNotices) return;
    try {
      setNoticeRows(await api.get<NoticeLine[]>('/api/inbox/mine/notices'));
      setNoticeNow(Date.now());
    } catch {
      // The notices are a side of the inbox: the conversations go on without them.
    }
  }, [withNotices]);
  useEffect(() => {
    void loadNotices();
    const timer = setInterval(() => {
      if (!document.hidden) void loadNotices();
    }, 15_000);
    return () => clearInterval(timer);
  }, [loadNotices]);
  /** A customer's photo taken as a remittance notice, and opened beside the conversation. */
  const takeNotice = async (messageId: string) => {
    try {
      const { id } = await api.post<{ id: string }>('/api/inbox/mine/notices', { messageId });
      setActiveNotice(id);
      void loadNotices();
    } catch (cause) {
      toast.error(
        t('errors.title'),
        cause instanceof ApiError ? say(t, cause.messageKey, cause.params) || cause.message : t('errors.generic'),
      );
    }
  };
  const checkingCount = noticeRows.filter((row) => row.status === 'CHECKING' || row.status === 'NEW').length;
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
  /** The number's groups, to follow one and open it: null while the sheet is shut. */
  const [numberGroups, setNumberGroups] = useState<
    { chat: string; name: string; size: number; followed: boolean }[] | null | 'loading'
  >(null);
  const [groupQuery, setGroupQuery] = useState('');
  const [following, setFollowing] = useState<string | null>(null);

  const openGroups = async () => {
    if (!groupsApi) return;
    setNumberGroups('loading');
    setGroupQuery('');
    try {
      setNumberGroups(await api.get(groupsApi));
    } catch (cause) {
      failure(cause);
      setNumberGroups(null);
    }
  };

  /** Followed and opened: what is written in it from now on reaches the inbox. */
  const follow = async (chat: string, on: boolean) => {
    if (!groupsApi) return;
    setFollowing(chat);
    try {
      const result = await api.post<{ id: string | null }>(groupsApi, { chat, follow: on });
      if (on && result.id) {
        setNumberGroups(null);
        setListView('groups');
        setThread(null);
        setSelected(result.id);
        toast.success(t('inbox.groupFollowed'));
      } else {
        setNumberGroups((current) =>
          Array.isArray(current) ? current.map((group) => (group.chat === chat ? { ...group, followed: false } : group)) : current,
        );
        toast.success(t('inbox.groupUnfollowed'));
      }
      void load();
    } catch (cause) {
      failure(cause);
    } finally {
      setFollowing(null);
    }
  };

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

  /** A photo opened over everything. */
  const [viewing, setViewing] = useState<string | null>(null);
  /** On a touch screen: the message tapped, whose actions are shown beside it. */
  const [tapped, setTapped] = useState<string | null>(null);
  /** The message whose reactions are open, and the emoji sheet beside the box. */
  const [reactingTo, setReactingTo] = useState<string | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  /** A message being sent on to another conversation, and where. */
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [forwardQuery, setForwardQuery] = useState('');
  const [forwardingTo, setForwardingTo] = useState<string | null>(null);
  /*
   * How this person keeps the inbox: quick replies, labels, and which
   * conversations are pinned, archived or left unread. Not while watching
   * another's number — that is theirs to keep.
   */
  const scope = readOnly ? null : base === '/api/inbox/mine' ? 'teller' : base === '/api/inbox' ? 'bot' : null;
  const [org, setOrg] = useState<Organisation>({ labels: [], marks: {} });
  const [replies, setReplies] = useState<QuickReply[]>([]);
  const [repliesOpen, setRepliesOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<{ id: string; at: { top: number; bottom: number; left: number; right: number } } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [pickIndex, setPickIndex] = useState(0);
  useEffect(() => {
    if (!scope) return;
    void api.get<Organisation>(`/api/inbox/organise?scope=${scope}`).then(setOrg).catch(() => undefined);
    void api.get<QuickReply[]>('/api/inbox/replies').then(setReplies).catch(() => undefined);
  }, [scope]);
  const markOf = (id: string): ChatMark | undefined => org.marks[id];
  const markChat = async (chatId: string, change: Partial<Pick<ChatMark, 'pinned' | 'archived' | 'markedUnread' | 'labels'>>) => {
    setMenuFor(null);
    if (!scope) return;
    try {
      setOrg(await api.put<Organisation>('/api/inbox/organise', { scope, chatId, ...change }));
    } catch (cause) {
      failure(cause);
    }
  };
  const saveReply = async (reply: { id?: string; shortcut: string; text: string; shared: boolean }) => {
    try {
      setReplies(await api.post<QuickReply[]>('/api/inbox/replies', reply));
      return true;
    } catch (cause) {
      failure(cause);
      return false;
    }
  };
  const removeReply = async (id: string) => {
    try {
      setReplies(await api.delete<QuickReply[]>(`/api/inbox/replies/${id}`));
    } catch (cause) {
      failure(cause);
    }
  };
  const saveLabel = async (label: { id?: string; name: string; color: string }) => {
    try {
      setOrg(await api.post<Organisation>('/api/inbox/labels', { scope, ...label }));
      return true;
    } catch (cause) {
      failure(cause);
      return false;
    }
  };
  const removeLabel = async (id: string) => {
    try {
      setOrg(await api.delete<Organisation>(`/api/inbox/labels/${id}?scope=${scope}`));
      if (labelFilter === id) setLabelFilter(null);
    } catch (cause) {
      failure(cause);
    }
  };
  // "/" at the start of the box: the replies it finds.
  const found = scope ? matchReplies(replies, draft) : null;
  useEffect(() => {
    setPickIndex(0);
  }, [draft]);
  const pickReply = (reply: QuickReply) => {
    setDraft(fillReply(reply.text, thread?.name ?? null));
    requestAnimationFrame(() => box.current?.focus());
  };

  /** Looking for words in this conversation: what, and which of the places found is shown. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [hit, setHit] = useState(0);

  /** A reaction put on, or the same one again taken off, as WhatsApp does. */
  const react = async (message: Message, emoji: string) => {
    setReactingTo(null);
    if (!thread) return;
    const current = message.reactions?.find((entry) => entry.mine)?.emoji ?? null;
    try {
      setThread(
        await api.patch<Thread>(`${base}/${thread.id}`, {
          messageId: message.id,
          react: current === emoji ? '' : emoji,
        }),
      );
    } catch (cause) {
      failure(cause);
    }
  };

  /** An emoji put where the cursor is in the box. */
  const putEmoji = (emoji: string) => {
    const field = box.current;
    const at = field?.selectionStart ?? draft.length;
    const end = field?.selectionEnd ?? at;
    setDraft((current) => current.slice(0, at) + emoji + current.slice(end));
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(at + emoji.length, at + emoji.length);
    });
  };

  /** Sent on to another conversation: its words, and its photo when it has one. */
  const forwardTo = async (targetId: string) => {
    if (!forwarding || forwardingTo) return;
    setForwardingTo(targetId);
    try {
      let image: string | undefined;
      if (forwarding.imageId && (forwarding.mediaKind ?? 'image') === 'image') {
        const blob = await (await fetch(`/api/inbox/images/${forwarding.imageId}`)).blob();
        image = await shrinkPhoto(new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' }));
      }
      await api.post(`${base}/${targetId}`, { text: forwarding.text, ...(image ? { image } : {}) });
      toast.success(t('inbox.forwarded'));
      setForwarding(null);
      void load();
    } catch (cause) {
      failure(cause);
    } finally {
      setForwardingTo(null);
    }
  };

  const needle = term.trim().toLowerCase();
  const hits = needle
    ? (thread?.messages ?? []).filter((message) => !message.deleted && message.text.toLowerCase().includes(needle))
    : [];
  const shownHit = hits.length ? hits[Math.min(hit, hits.length - 1)] : undefined;
  // The place found is brought into view, the newest first.
  useEffect(() => {
    if (!shownHit) return;
    document.getElementById(`m-${shownHit.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [shownHit]);
  useEffect(() => {
    setHit(0);
  }, [needle]);
  useEffect(() => {
    setSearchOpen(false);
    setTerm('');
  }, [selected]);
  /** Whether the conversation is read at its end; when not, what came since waits under a button. */
  const atEnd = useRef(true);
  const [below, setBelow] = useState(0);
  const [nearEnd, setNearEnd] = useState(true);
  const toEnd = useCallback((smooth = false) => {
    const list = scroller.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atEnd.current = true;
    setNearEnd(true);
    setBelow(0);
  }, []);
  const onScroll = () => {
    const list = scroller.current;
    if (!list) return;
    atEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    setNearEnd(atEnd.current);
    if (atEnd.current) setBelow(0);
  };

  // A conversation opens at its end.
  const openId = thread?.id;
  useEffect(() => {
    if (!openId) return;
    toEnd();
    // Photos load after it is drawn and push the end down, so it is followed once more.
    const later = [setTimeout(() => toEnd(), 400), setTimeout(() => toEnd(), 1500)];
    return () => later.forEach(clearTimeout);
  }, [openId, toEnd]);

  // Something new: followed when reading at the end or when it is ours, else counted on the button.
  const lastId = thread?.messages.at(-1)?.id;
  const lastMine = thread?.messages.at(-1)?.role !== 'customer';
  const seenLast = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!lastId || seenLast.current === lastId) return;
    const first = seenLast.current === undefined;
    seenLast.current = lastId;
    if (first) return;
    if (atEnd.current || lastMine) {
      toEnd(true);
      const later = setTimeout(() => toEnd(), 500);
      return () => clearTimeout(later);
    }
    setBelow((count) => count + 1);
  }, [lastId, lastMine, toEnd]);
  useEffect(() => {
    seenLast.current = undefined;
    setBelow(0);
  }, [openId]);

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
    if (found && found.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setPickIndex((index) => (index + (event.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        pickReply(found[Math.min(pickIndex, found.length - 1)]!);
        return;
      }
    }
    if (found && event.key === 'Escape') {
      event.preventDefault();
      setDraft('');
      return;
    }
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
          // On a phone the number picker takes the row and the buttons shrink to icons.
          <div className="flex w-full items-center gap-2 sm:w-auto sm:flex-wrap [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1 sm:[&>*:first-child]:flex-none">
            {tabs}
            {readOnly ? (
              <Badge tone="warning">
                <Eye className="me-1 inline size-3.5" />
                {t('inbox.watchReadOnly')}
              </Badge>
            ) : (
              <>
                {groupsApi && (
                  <Button
                    variant="secondary"
                    icon={<Users />}
                    aria-label={t('inbox.numberGroups')}
                    title={t('inbox.numberGroups')}
                    onClick={() => void openGroups()}
                    className="shrink-0"
                  >
                    <span className="hidden sm:inline">{t('inbox.numberGroups')}</span>
                  </Button>
                )}
                <Button
                  icon={<MessageSquarePlus />}
                  aria-label={t('inbox.newChat')}
                  title={t('inbox.newChat')}
                  onClick={() => setFresh((current) => ({ ...current, open: true }))}
                  className="shrink-0"
                >
                  <span className="hidden sm:inline">{t('inbox.newChat')}</span>
                </Button>
              </>
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
  const inView = rows.filter(
    (row) =>
      (listView === 'groups' ? Boolean(row.group) : !row.group) &&
      (listView !== 'waiting' || row.awaiting) &&
      (!digits || (row.phone ?? '').includes(digits)) &&
      (digits || !words || row.lastText.includes(words) || (row.name ?? '').includes(words)) &&
      (!labelFilter || (org.marks[row.id]?.labels ?? []).includes(labelFilter)),
  );
  // Archived: out of the list, one row away — unless what is looked for is there.
  const archivedRows = inView.filter((row) => org.marks[row.id]?.archived);
  const searching = Boolean(digits || words);
  const shown = (showArchived ? archivedRows : searching ? inView : inView.filter((row) => !org.marks[row.id]?.archived))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const pa = org.marks[a.row.id]?.pinned ? new Date(org.marks[a.row.id]!.pinnedAt ?? 0).getTime() : -1;
      const pb = org.marks[b.row.id]?.pinned ? new Date(org.marks[b.row.id]!.pinnedAt ?? 0).getTime() : -1;
      if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.row);
  const archivedUnread = archivedRows.filter((row) => row.unread > 0 || org.marks[row.id]?.markedUnread).length;

  return (
    <div className="space-y-4">
      {header}
      <div
        className={`grid gap-4 md:grid-cols-[20rem_minmax(0,1fr)] lg:grid-cols-[21rem_minmax(0,1fr)] ${
          activeNotice ? '2xl:grid-cols-[21rem_minmax(0,1fr)_24rem]' : ''
        }`}
      >
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
            <div className="flex gap-1 overflow-x-auto rounded-xl bg-surface-sunken p-1 text-sm [scrollbar-width:none]">
              {(['people', 'waiting', 'groups', ...(withNotices ? (['notices'] as const) : [])] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={listView === view}
                  onClick={() => setListView(view)}
                  className={`min-h-9 flex-1 shrink-0 whitespace-nowrap rounded-lg px-2 py-1.5 font-medium ${
                    listView === view
                      ? 'bg-surface text-content shadow-sm'
                      : 'text-content-secondary'
                  }`}
                >
                  {view === 'waiting'
                    ? t('inbox.waiting', { count: waitingCount })
                    : view === 'groups'
                      ? t('inbox.groups')
                      : view === 'notices'
                        ? `${t('inbox.notice.tab')}${checkingCount ? ` (${checkingCount})` : ''}`
                        : t('inbox.people')}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {listView === 'notices' ? (
              noticeRows.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-content-tertiary">{t('inbox.notice.none')}</p>
              ) : (
                noticeRows.map((row) => {
                  const late = row.status === 'CHECKING' ? checkingLate(row.sentAt, noticeNow) : 'ok';
                  return (
                    <button
                      key={row.id}
                      type="button"
                      aria-pressed={activeNotice === row.id}
                      onClick={() => {
                        setSelected(row.chatId);
                        setThread(null);
                        setActiveNotice(row.id);
                      }}
                      className={`flex w-full items-center gap-3 border-b border-s-4 border-border-subtle px-3 py-2.5 text-start last:border-b-0 ${
                        late === 'veryLate' ? 'border-s-danger' : late === 'late' ? 'border-s-warning' : 'border-s-transparent'
                      } ${activeNotice === row.id ? 'bg-primary-subtle' : 'hover:bg-surface-sunken'}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/inbox/images/${row.imageId}`}
                        alt=""
                        loading="lazy"
                        className="size-11 shrink-0 rounded-lg bg-surface-sunken object-cover ring-1 ring-border-subtle"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold text-content">
                            {row.customerName ?? (row.customerPhone ? `+${row.customerPhone}` : '—')}
                          </span>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLE[row.status]}`}>
                            {t(`inbox.notice.status.${row.status}`)}
                          </span>
                        </span>
                        <span className="mt-0.5 flex items-center justify-between gap-2 text-xs text-content-secondary">
                          <span className="truncate">
                            {t(`inbox.notice.network.${row.network}`)}
                            {row.amount && ` · ${Number(row.amount) / 1e8} ${row.currency ?? ''}`}
                          </span>
                          {(row.replyCount ?? 0) > 0 && (
                            <span className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] font-bold text-white">
                              {row.replyCount}
                            </span>
                          )}
                        </span>
                        {row.agentName && (
                          <span className="block truncate text-[11px] text-content-tertiary">{row.agentName}</span>
                        )}
                      </span>
                    </button>
                  );
                })
              )
            ) : (
              <>
              {scope && (org.labels.length > 0 || showArchived) && (
                <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border-subtle px-3 py-2 [scrollbar-width:none]">
                  {org.labels.map((label) => (
                    <button
                      key={label.id}
                      type="button"
                      aria-pressed={labelFilter === label.id}
                      onClick={() => setLabelFilter((current) => (current === label.id ? null : label.id))}
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition-colors ${
                        labelFilter === label.id ? 'text-white ring-transparent' : 'bg-surface text-content-secondary ring-border-subtle'
                      }`}
                      style={labelFilter === label.id ? { background: label.color } : undefined}
                    >
                      <Tag className="size-3" style={labelFilter === label.id ? undefined : { color: label.color }} />
                      {label.name}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setLabelsOpen(true)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold text-primary-text hover:bg-surface-sunken"
                  >
                    <Tag className="size-3" />
                    {t('inbox.labels.title')}
                  </button>
                </div>
              )}
              {scope && showArchived ? (
                <button
                  type="button"
                  onClick={() => setShowArchived(false)}
                  className="flex w-full items-center gap-3 border-b border-border-subtle px-4 py-3 text-start text-sm font-semibold text-content hover:bg-surface-sunken/60"
                >
                  <ArrowLeft className="size-4 rtl:-scale-x-100" />
                  {t('inbox.archived')}
                </button>
              ) : (
                scope &&
                !searching &&
                archivedRows.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowArchived(true)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-surface-sunken/60"
                  >
                    <span className="inline-flex size-11 shrink-0 items-center justify-center">
                      <Archive className="size-5 wa-accent-text" />
                    </span>
                    <span className="flex-1 text-[15px] font-semibold text-content">{t('inbox.archived')}</span>
                    <span className={`text-xs font-semibold tabular-nums ${archivedUnread ? 'wa-accent-text' : 'text-content-tertiary'}`}>
                      {archivedUnread || archivedRows.length}
                    </span>
                  </button>
                )
              )}
              {shown.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-content-tertiary">
                {t('inbox.empty')}
              </p>
            ) : (
              shown.map((row) => (
                <div key={row.id} className="group/row relative">
                <button
                  type="button"
                  aria-pressed={selected === row.id}
                  onClick={() => {
                    setSelected(row.id);
                    setThread(null);
                    setDraft('');
                    setPhoto(null);
                    setQuote(null);
                    if (markOf(row.id)?.markedUnread) void markChat(row.id, { markedUnread: false });
                  }}
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-start transition-colors ${
                    selected === row.id ? 'bg-surface-sunken' : 'hover:bg-surface-sunken/60'
                  }`}
                >
                  <Avatar name={row.name} phone={row.phone} group={row.group} />
                  <span className="min-w-0 flex-1 border-b border-border-subtle pb-2.5">
                  <span className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-content">
                      {row.name ?? (
                        <span className="ltr-content tabular-nums">
                          {phoneOf(row.phone) ?? t('inbox.phoneHidden')}
                        </span>
                      )}
                    </span>
                    <span
                      className={`shrink-0 text-[11px] tabular-nums ${
                        row.unread > 0 || markOf(row.id)?.markedUnread ? 'font-semibold wa-accent-text' : 'text-content-tertiary'
                      } ${scope ? 'transition-opacity group-hover/row:opacity-0' : ''}`}
                      title={when(row.lastMessageAt)}
                    >
                      {listTime(row.lastMessageAt, t('inbox.yesterday'))}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span
                      className={`flex min-w-0 items-center gap-1 truncate text-[13px] ${
                        row.unread > 0 ? 'font-semibold text-content' : 'text-content-secondary'
                      }`}
                    >
                      {row.lastFromMe && <Ticks ack={row.lastAck ?? null} className="shrink-0 wa-meta" />}
                      <span className="truncate">{row.lastText}</span>
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
                    ) : row.unread > 0 || markOf(row.id)?.markedUnread ? (
                      <span className="flex shrink-0 items-center gap-1">
                        {markOf(row.id)?.pinned && (
                          <Pin className="size-3.5 rotate-45 text-content-tertiary" aria-label={t('inbox.menu.pin')} />
                        )}
                        <span className="inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-5 text-white tabular-nums wa-accent-bg">
                          {row.unread > 99 ? '99+' : row.unread > 0 ? row.unread : ''}
                        </span>
                      </span>
                    ) : markOf(row.id)?.pinned ? (
                      <Pin className="size-3.5 shrink-0 rotate-45 text-content-tertiary" aria-label={t('inbox.menu.pin')} />
                    ) : (
                      row.awaiting && (
                        <span className="shrink-0 rounded-full bg-warning-subtle px-1.5 py-px text-[10px] font-semibold text-warning-text">
                          {t('inbox.awaiting')}
                        </span>
                      )
                    )}
                  </span>
                  {(markOf(row.id)?.labels.length ?? 0) > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {org.labels
                        .filter((label) => markOf(row.id)!.labels.includes(label.id))
                        .map((label) => (
                          <span
                            key={label.id}
                            className="inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold text-white"
                            style={{ background: label.color }}
                          >
                            {label.name}
                          </span>
                        ))}
                    </span>
                  )}
                  </span>
                </button>
                {scope && (
                  <button
                    type="button"
                    aria-label={t('inbox.menu.open')}
                    title={t('inbox.menu.open')}
                    onClick={(event) => {
                      const box = event.currentTarget.getBoundingClientRect();
                      setMenuFor((current) =>
                        current?.id === row.id
                          ? null
                          : { id: row.id, at: { top: box.top, bottom: box.bottom, left: box.left, right: box.right } },
                      );
                    }}
                    className={`absolute end-2 top-2 inline-flex size-8 items-center justify-center rounded-full bg-surface text-content-secondary shadow-sm ring-1 ring-border-subtle transition-opacity hover:text-content ${
                      touch || menuFor?.id === row.id ? '' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'
                    }`}
                  >
                    <MoreVertical className="size-4" />
                  </button>
                )}
                {menuFor?.id === row.id && (
                  <ChatMenu
                    at={menuFor.at}
                    mark={markOf(row.id)}
                    labels={org.labels}
                    onChange={(change) => void markChat(row.id, change)}
                    onNewLabel={() => {
                      setMenuFor(null);
                      setLabelsOpen(true);
                    }}
                    onClose={() => setMenuFor(null)}
                  />
                )}
                </div>
              ))
            )}
              </>
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
              <div className="flex shrink-0 items-center gap-2.5 border-b border-border-subtle bg-surface px-2 py-2 sm:px-4">
                <button
                  type="button"
                  aria-label={t('inbox.back')}
                  onClick={() => setSelected(null)}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken md:hidden"
                >
                  <ArrowLeft className="size-5 rtl:-scale-x-100" />
                </button>
                <Avatar name={thread.name} phone={thread.phone} group={thread.group} size="sm" />
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
                <button
                  type="button"
                  aria-label={t('inbox.searchChat')}
                  title={t('inbox.searchChat')}
                  onClick={() => {
                    setSearchOpen((open) => !open);
                    setTerm('');
                  }}
                  className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full hover:bg-surface-sunken ${
                    searchOpen ? 'bg-surface-sunken text-content' : 'text-content-secondary'
                  }`}
                >
                  <Search className="size-5" />
                </button>
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

              {searchOpen && (
                <div className="flex shrink-0 items-center gap-1.5 border-b border-border-subtle bg-surface px-2 py-1.5">
                  <Input
                    autoFocus
                    value={term}
                    onChange={(event) => setTerm(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && hits.length) setHit((index) => (index + 1) % hits.length);
                      if (event.key === 'Escape') setSearchOpen(false);
                    }}
                    placeholder={t('inbox.searchChatPlaceholder')}
                    iconStart={<Search className="size-4" />}
                    className="h-9"
                  />
                  <span className="shrink-0 px-1 text-xs tabular-nums text-content-tertiary">
                    {needle ? `${hits.length ? hits.length - Math.min(hit, hits.length - 1) : 0}/${hits.length}` : ''}
                  </span>
                  <button
                    type="button"
                    aria-label={t('inbox.searchOlder')}
                    disabled={hits.length < 2}
                    onClick={() => setHit((index) => (index + 1) % hits.length)}
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken disabled:opacity-40"
                  >
                    <ChevronUp className="size-5" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('inbox.searchNewer')}
                    disabled={hits.length < 2}
                    onClick={() => setHit((index) => (index - 1 + hits.length) % hits.length)}
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken disabled:opacity-40"
                  >
                    <ChevronDown className="size-5" />
                  </button>
                  <button
                    type="button"
                    aria-label={t('common.close')}
                    onClick={() => setSearchOpen(false)}
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              )}
              {busy.get(thread.phone ?? '') && (
                <p className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning-subtle px-3 py-2 text-xs font-semibold text-warning-text">
                  <Headset className="size-4 shrink-0" />
                  {busy.get(thread.phone ?? '')!.typing
                    ? t('inbox.busyTypingLong', { name: busy.get(thread.phone ?? '')!.name })
                    : t('inbox.busyWith', { name: busy.get(thread.phone ?? '')!.name })}
                </p>
              )}
              <div className="relative flex min-h-0 flex-1 flex-col">
              <div
                ref={scroller}
                onScroll={onScroll}
                className="wa-wall flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 pb-3 pt-1 sm:px-[5%]"
              >
                {thread.messages.map((message, index) => {
                  const before = thread.messages[index - 1];
                  const mine = message.role !== 'customer';
                  const newDay = !before || dayKeyOf(before.createdAt) !== dayKeyOf(message.createdAt);
                  // A run: one side, one writer, one day — only its first has the tail and the name.
                  const firstOfRun =
                    newDay ||
                    !before ||
                    before.role !== message.role ||
                    (before.authorName ?? '') !== (message.authorName ?? '');
                  const quoted =
                    message.quotedId !== undefined && message.quotedId !== null
                      ? (thread.messages.find((other) => other.id === message.quotedId) ?? null)
                      : undefined;
                  const writer = message.authorName ?? (message.role === 'bot' ? t('inbox.role.bot') : null);
                  return (
                    <Fragment key={message.id}>
                      {newDay && (
                        <div className="sticky top-1 z-10 my-2 self-center rounded-lg px-3 py-1 text-xs font-medium wa-chip">
                          {dayChip(message.createdAt, locale, { today: t('inbox.today'), yesterday: t('inbox.yesterday') })}
                        </div>
                      )}
                      <div
                        id={`m-${message.id}`}
                        className={`group relative flex items-start gap-1 ${mine ? 'flex-row-reverse' : ''} ${firstOfRun ? 'mt-2' : 'mt-0.5'} ${
                          message.reactions?.length ? 'mb-3.5' : ''
                        }`}
                      >
                        <div
                          onClick={touch ? () => setTapped((current) => (current === message.id ? null : message.id)) : undefined}
                          className={`wa-bubble max-w-[85%] rounded-lg px-2 pb-1 pt-1 text-[14.5px] leading-snug sm:max-w-[65%] ${
                            mine ? 'wa-out' : 'wa-in'
                          } ${firstOfRun ? (mine ? 'wa-tail-out rounded-se-none' : 'wa-tail-in rounded-ss-none') : ''} ${
                            shownHit?.id === message.id ? 'ring-2 ring-yellow-400' : ''
                          }`}
                        >
                          {firstOfRun && writer && (thread.group || mine) && (
                            <p className="mb-0.5 text-[12.5px] font-semibold" style={{ color: colourOf(writer) }}>
                              {writer}
                            </p>
                          )}
                          {quoted !== undefined && <QuoteLine message={quoted} />}
                          {message.imageId && <MediaView message={message} onOpen={setViewing} />}
                          {withNotices && message.imageId && message.role === 'customer' && !message.deleted && (
                            <button
                              type="button"
                              onClick={() => void takeNotice(message.id)}
                              className="mb-1 inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2.5 py-1 text-[11px] font-bold text-primary-text hover:bg-primary/15"
                            >
                              <BadgeDollarSign className="size-3.5" />
                              {t('inbox.notice.take')}
                            </button>
                          )}
                          {message.deleted ? (
                            <span className="italic wa-meta">🚫 {t('inbox.deleted')}</span>
                          ) : (
                            message.text && (
                              <span className="whitespace-pre-wrap break-words">
                                <Marked text={message.text} term={needle ? term.trim() : ''} />
                              </span>
                            )
                          )}
                          {/* Time and ticks sit at the end of the last line, as WhatsApp sets them. */}
                          <span className="float-end ms-3 mt-1.5 inline-flex translate-y-0.5 items-center gap-1 text-[11px] leading-none wa-meta">
                            {message.edited && !message.deleted && <span>{t('inbox.edited')}</span>}
                            <span className="tabular-nums" title={when(message.createdAt)}>
                              {clockOf(message.createdAt)}
                            </span>
                            {mine && !message.deleted && <Ticks ack={message.ack} />}
                          </span>
                          {/* Reactions sit on the bubble's lower edge, as WhatsApp draws them. */}
                          {message.reactions && message.reactions.length > 0 && (
                            <button
                              type="button"
                              disabled={readOnly || !message.reactable}
                              onClick={(event) => {
                                event.stopPropagation();
                                setReactingTo(message.id);
                              }}
                              className={`absolute -bottom-3.5 ${mine ? 'end-2' : 'start-2'} inline-flex items-center gap-0.5 rounded-full bg-surface px-1.5 py-0.5 text-sm leading-none shadow ring-1 ring-border-subtle`}
                            >
                              {message.reactions.map((entry) => (
                                <span key={entry.emoji} className={entry.mine ? 'drop-shadow' : ''}>
                                  {entry.emoji}
                                </span>
                              ))}
                              {message.reactions.reduce((sum, entry) => sum + entry.count, 0) > 1 && (
                                <span className="ms-0.5 text-[11px] text-content-secondary tabular-nums">
                                  {message.reactions.reduce((sum, entry) => sum + entry.count, 0)}
                                </span>
                              )}
                            </button>
                          )}
                        </div>
                        {/* What can be done to it: shown on hover, always there on a touch screen. */}
                        {!readOnly && !message.deleted && (!touch || tapped === message.id) && (
                          <span
                            className={`flex shrink-0 items-center gap-0.5 self-center transition-opacity ${
                              touch ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                            }`}
                          >
                            {message.reactable && (
                              <span className="relative">
                                <button
                                  type="button"
                                  aria-label={t('inbox.react')}
                                  title={t('inbox.react')}
                                  onClick={() => setReactingTo(message.id)}
                                  className="inline-flex size-7 items-center justify-center rounded-full bg-surface/80 text-content-secondary shadow-sm hover:text-content"
                                >
                                  <SmilePlus className="size-3.5" />
                                </button>
                              </span>
                            )}
                            {(message.text || (message.imageId && (message.mediaKind ?? 'image') === 'image')) && (
                              <button
                                type="button"
                                aria-label={t('inbox.forward')}
                                title={t('inbox.forward')}
                                onClick={() => {
                                  setForwardQuery('');
                                  setForwarding(message);
                                }}
                                className="inline-flex size-7 items-center justify-center rounded-full bg-surface/80 text-content-secondary shadow-sm hover:text-content"
                              >
                                <Forward className="size-3.5" />
                              </button>
                            )}
                            {message.quotable && (
                              <button
                                type="button"
                                aria-label={t('inbox.quote')}
                                title={t('inbox.quote')}
                                onClick={() => {
                                  setQuote(message);
                                  box.current?.focus();
                                }}
                                className="inline-flex size-7 items-center justify-center rounded-full bg-surface/80 text-content-secondary shadow-sm hover:text-content"
                              >
                                <Reply className="size-3.5" />
                              </button>
                            )}
                            {message.text && (
                              <button
                                type="button"
                                aria-label={t('inbox.copy')}
                                title={t('inbox.copy')}
                                onClick={() => {
                                  void navigator.clipboard?.writeText(message.text);
                                  toast.success(t('inbox.copied'));
                                }}
                                className="hidden size-7 items-center justify-center rounded-full bg-surface/80 text-content-secondary shadow-sm hover:text-content sm:inline-flex"
                              >
                                <Copy className="size-3.5" />
                              </button>
                            )}
                            {message.editable && (
                              <button
                                type="button"
                                aria-label={t('inbox.edit')}
                                title={t('inbox.edit')}
                                onClick={() => setEditing({ id: message.id, text: message.text })}
                                className="inline-flex size-7 items-center justify-center rounded-full bg-surface/80 text-content-secondary shadow-sm hover:text-content"
                              >
                                <Pencil className="size-3.5" />
                              </button>
                            )}
                            {message.deletable && (
                              <button
                                type="button"
                                aria-label={t('inbox.delete')}
                                title={t('inbox.delete')}
                                onClick={() => setDeleting(message)}
                                className="inline-flex size-7 items-center justify-center rounded-full bg-surface/80 text-content-secondary shadow-sm hover:text-danger-text"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            )}
                          </span>
                        )}
                        {reactingTo === message.id && (
                          <EmojiSheet
                            emojis={QUICK_REACTIONS}
                            chosen={message.reactions?.find((entry) => entry.mine)?.emoji ?? null}
                            onPick={(emoji) => void react(message, emoji)}
                            onClose={() => setReactingTo(null)}
                            className={`grid-cols-6 ${mine ? 'end-10' : 'start-10'} -mt-12`}
                          />
                        )}
                      </div>
                    </Fragment>
                  );
                })}
              </div>
              {/* Read further up: the way back down, with how many came since. */}
              {below > 0 && (
                <button
                  type="button"
                  onClick={() => toEnd(true)}
                  aria-label={t('inbox.toLatest')}
                  className="absolute bottom-3 end-3 inline-flex size-11 items-center justify-center rounded-full bg-surface text-content-secondary shadow-[var(--shadow-lg)] ring-1 ring-border-subtle hover:text-content"
                >
                  <ChevronDown className="size-5" />
                  <span className="absolute -end-1 -top-1.5 inline-flex min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold leading-5 text-white wa-accent-bg">
                    {below}
                  </span>
                </button>
              )}
              {below === 0 && !nearEnd && (
                <button
                  type="button"
                  onClick={() => toEnd(true)}
                  aria-label={t('inbox.toLatest')}
                  className="absolute bottom-3 end-3 inline-flex size-11 items-center justify-center rounded-full bg-surface text-content-secondary shadow-[var(--shadow-lg)] ring-1 ring-border-subtle hover:text-content"
                >
                  <ChevronDown className="size-5" />
                </button>
              )}
              </div>

              {readOnly ? (
                <p className="flex shrink-0 items-center justify-center gap-1.5 border-t border-border-subtle bg-warning-subtle/40 p-3 text-xs font-medium text-warning-text">
                  <Eye className="size-4" />
                  {t('inbox.watchNoAnswer')}
                </p>
              ) : (
              <div className="relative shrink-0 space-y-1.5 border-t border-border-subtle bg-surface-sunken px-2 py-2 sm:px-3">
                {found && (
                  <ReplyPicker
                    found={found}
                    active={Math.min(pickIndex, Math.max(0, found.length - 1))}
                    onPick={pickReply}
                    onManage={() => setRepliesOpen(true)}
                  />
                )}
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
                  {/* The box as WhatsApp draws it: one rounded field, the clip inside it. */}
                  <div className="relative flex min-w-0 flex-1 items-end gap-1 rounded-3xl bg-surface px-1.5 py-1 shadow-sm ring-1 ring-border-subtle focus-within:ring-2 focus-within:ring-[var(--wa-accent)]">
                  <button
                    type="button"
                    aria-label={t('inbox.emoji')}
                    title={t('inbox.emoji')}
                    onClick={() => setEmojiOpen((open) => !open)}
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken hover:text-content"
                  >
                    <Smile className="size-5" />
                  </button>
                  {scope && (
                    <button
                      type="button"
                      aria-label={t('inbox.replies.title')}
                      title={t('inbox.replies.title')}
                      onClick={() => setRepliesOpen(true)}
                      className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken hover:text-content"
                    >
                      <Zap className="size-5" />
                    </button>
                  )}
                  {emojiOpen && (
                    <EmojiSheet
                      emojis={EMOJIS}
                      onPick={putEmoji}
                      onClose={() => setEmojiOpen(false)}
                      className="bottom-full start-0 mb-2 max-h-64 w-[min(22rem,calc(100vw-2rem))] grid-cols-8 overflow-y-auto"
                    />
                  )}
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
                    className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-content-secondary hover:bg-surface-sunken hover:text-content"
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
                    className="min-h-9 flex-1 resize-none border-0 bg-transparent px-1.5 py-2 text-base shadow-none ring-0 focus:ring-0 focus-visible:ring-0 sm:text-[15px]"
                  />
                  </div>
                  <button
                    type="button"
                    aria-label={t('inbox.send')}
                    title={t('inbox.send')}
                    disabled={sending || (!draft.trim() && !photo)}
                    onClick={() => void send()}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-white shadow-sm transition-opacity disabled:opacity-40 wa-accent-bg"
                  >
                    {sending ? (
                      <span className="size-5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    ) : (
                      <SendHorizontal className="size-5 rtl:-scale-x-100" />
                    )}
                  </button>
                </div>
                <p className="hidden text-xs text-content-tertiary md:block">
                  {hint} {t('inbox.pasteHint')}
                </p>
              </div>
              )}
            </>
          )}
        </Card>
        {activeNotice && (
          // A drawer over the page (above the ticker) until the screen is wide enough for a third column.
          <div
            className="fixed inset-0 z-50 flex justify-end 2xl:static 2xl:z-auto 2xl:block"
            role="dialog"
            aria-label={t('inbox.notice.tab')}
          >
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={() => setActiveNotice(null)}
              className="absolute inset-0 bg-black/30 backdrop-blur-[1px] 2xl:hidden"
            />
            <Card className="relative flex h-full w-full flex-col overflow-hidden rounded-none p-0 pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-lg)] sm:max-w-md 2xl:h-[calc(100dvh-13.5rem)] 2xl:max-w-none 2xl:rounded-2xl 2xl:pb-0 2xl:shadow-none">
              <NoticePanel
                noticeId={activeNotice}
                onClose={() => setActiveNotice(null)}
                onChanged={() => void loadNotices()}
              />
            </Card>
          </div>
        )}
      </div>
      <Lightbox src={viewing} onClose={() => setViewing(null)} label={t('inbox.photo')} />
      {scope && (
        <>
          <RepliesDialog
            open={repliesOpen}
            onClose={() => setRepliesOpen(false)}
            replies={replies}
            canShare={canShare}
            onSave={saveReply}
            onRemove={(id) => void removeReply(id)}
          />
          <LabelsDialog
            open={labelsOpen}
            onClose={() => setLabelsOpen(false)}
            labels={org.labels}
            onSave={saveLabel}
            onRemove={(id) => void removeLabel(id)}
          />
        </>
      )}
      <Dialog
        open={forwarding !== null}
        onClose={() => setForwarding(null)}
        title={t('inbox.forwardTitle')}
        description={forwarding?.text ? forwarding.text.slice(0, 120) : t('inbox.photo')}
      >
        <div className="space-y-2">
          <Input
            value={forwardQuery}
            onChange={(event) => setForwardQuery(event.target.value)}
            placeholder={t('inbox.search')}
            iconStart={<Search className="size-4" />}
          />
          <ul className="max-h-[50vh] divide-y divide-border-subtle overflow-y-auto rounded-xl ring-1 ring-border-subtle">
            {(rows ?? [])
              .filter((row) => row.id !== thread?.id)
              .filter((row) => {
                const words = forwardQuery.trim();
                if (!words) return true;
                const digits = words.replace(/\D/g, '');
                return (row.name ?? '').includes(words) || (Boolean(digits) && (row.phone ?? '').includes(digits));
              })
              .slice(0, 60)
              .map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    disabled={forwardingTo !== null}
                    onClick={() => void forwardTo(row.id)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-start hover:bg-surface-sunken disabled:opacity-60"
                  >
                    <Avatar name={row.name} phone={row.phone} group={row.group} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-content">
                        {row.name ?? <span className="ltr-content tabular-nums">{phoneOf(row.phone)}</span>}
                      </span>
                      {row.name && row.phone && (
                        <span className="ltr-content block text-xs tabular-nums text-content-tertiary">{phoneOf(row.phone)}</span>
                      )}
                    </span>
                    {forwardingTo === row.id ? (
                      <span className="size-4 animate-spin rounded-full border-2 border-border-base border-t-primary" />
                    ) : (
                      <Forward className="size-4 text-content-tertiary" />
                    )}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      </Dialog>
      <Dialog
        open={numberGroups !== null}
        onClose={() => setNumberGroups(null)}
        title={t('inbox.numberGroups')}
        description={t('inbox.numberGroupsHint')}
      >
        {numberGroups === 'loading' ? (
          <Skeleton className="h-48 w-full" />
        ) : Array.isArray(numberGroups) && numberGroups.length === 0 ? (
          <p className="py-6 text-center text-sm text-content-tertiary">{t('inbox.numberGroupsNone')}</p>
        ) : Array.isArray(numberGroups) ? (
          <div className="space-y-2">
            <Input
              value={groupQuery}
              onChange={(event) => setGroupQuery(event.target.value)}
              placeholder={t('inbox.search')}
              iconStart={<Search className="size-4" />}
            />
            <ul className="max-h-[55vh] divide-y divide-border-subtle overflow-y-auto rounded-xl ring-1 ring-border-subtle">
              {numberGroups
                .filter((group) => !groupQuery.trim() || group.name.includes(groupQuery.trim()))
                .map((group) => (
                  <li key={group.chat} className="flex items-center gap-2 px-3 py-2">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-primary-text">
                      <Users className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-content">{group.name}</span>
                      <span className="block text-[11px] text-content-tertiary">
                        {t('inbox.groupMembers', { count: group.size })}
                        {group.followed && <> · <span className="font-semibold text-success-text">{t('inbox.groupFollowing')}</span></>}
                      </span>
                    </span>
                    {group.followed && (
                      <button
                        type="button"
                        disabled={following === group.chat}
                        onClick={() => void follow(group.chat, false)}
                        className="shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold text-content-tertiary hover:bg-danger-subtle hover:text-danger-text"
                      >
                        {t('inbox.groupUnfollow')}
                      </button>
                    )}
                    <Button size="sm" loading={following === group.chat} onClick={() => void follow(group.chat, true)}>
                      {t('inbox.groupOpen')}
                    </Button>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
      </Dialog>
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
        groupsApi="/api/inbox/mine/groups"
        notices
        canShare={canWatch}
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
