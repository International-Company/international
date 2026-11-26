'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  MessageSquareShare,
  RotateCw,
  Users,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

/** Colours a name is drawn in, the same name always the same, as WhatsApp does for group members. */
const PALETTE = ['#e17076', '#7bc862', '#e5ca77', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774', '#06cf9c', '#d64c8b'];

export function colourOf(seed: string | null | undefined): string {
  const text = seed ?? '';
  let hash = 0;
  for (let index = 0; index < text.length; index++) hash = (hash * 31 + text.charCodeAt(index)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

/** The first letters of a name, or the last digits of a number with none. */
function initialsOf(name: string | null, phone: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${[...words[0]!][0]}${[...words[1]!][0]}`;
  if (words.length === 1) return [...words[0]!].slice(0, 2).join('');
  return phone ? phone.slice(-2) : '?';
}

export function Avatar({
  name,
  phone,
  group,
  size = 'md',
}: {
  name: string | null;
  phone: string | null;
  group?: boolean;
  size?: 'sm' | 'md';
}) {
  const box = size === 'sm' ? 'size-9 text-xs' : 'size-11 text-sm';
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ${box}`}
      style={{ background: colourOf(name ?? phone) }}
    >
      {group ? <Users className="size-1/2" /> : initialsOf(name, phone)}
    </span>
  );
}

/**
 * How far one of ours got, as WhatsApp draws it: a clock while it goes, one
 * tick when WhatsApp took it, two when it reached the phone, two blue when read.
 */
export function Ticks({ ack, className = '' }: { ack: number | null | undefined; className?: string }) {
  if (ack === undefined) return null;
  if (ack === null || ack < 2) return <Clock className={`size-3.5 ${className}`} aria-label="…" />;
  if (ack === 2) return <Check className={`size-4 ${className}`} aria-label="✓" />;
  return <CheckCheck className={`size-4 ${ack >= 4 ? 'wa-read' : ''} ${className}`} aria-label="✓✓" />;
}

export const dayKeyOf = (value: string) => {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

export const clockOf = (value: string) =>
  new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));

/** Today, yesterday, the weekday this week, else the date — as the chips between days read. */
export function dayChip(value: string, locale: string, words: { today: string; yesterday: string }): string {
  const date = new Date(value);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const days = Math.round((start.getTime() - new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return words.today;
  if (days === 1) return words.yesterday;
  const tag = locale === 'ar' ? 'ar' : 'en-GB';
  if (days < 7) return new Intl.DateTimeFormat(tag, { weekday: 'long' }).format(date);
  return new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

/** In the list: the time today, "yesterday", else the date. */
export function listTime(value: string, yesterday: string): string {
  const date = new Date(value);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (date >= start) return clockOf(value);
  if (date >= new Date(start.getTime() - 86_400_000)) return yesterday;
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).format(date);
}

/** The reactions WhatsApp offers first. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/** The emojis a counter actually types, in the panel beside the box. */
export const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😎',
  '🤔', '🤗', '😅', '😌', '😴', '😢', '😭', '😮', '😡', '🙄', '😬', '😐',
  '👍', '👎', '👌', '👏', '🙏', '🤝', '✌️', '💪', '👋', '☝️', '👇', '👉',
  '❤️', '💚', '💙', '🔥', '⭐', '🌷', '🌹', '🎉', '✅', '❌', '⚠️', '⏳',
  '💵', '💰', '💳', '🏦', '📄', '📷', '📞', '📍', '🕐', '📌', '🔒', '💯',
];

/** A small sheet of emojis over what was tapped: a reaction's or the box's. */
export function EmojiSheet({
  emojis,
  chosen,
  onPick,
  onClose,
  className = '',
}: {
  emojis: string[];
  chosen?: string | null;
  onPick: (emoji: string) => void;
  onClose: () => void;
  className?: string;
}) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <>
      <button type="button" aria-hidden tabIndex={-1} className="fixed inset-0 z-30 cursor-default" onClick={onClose} />
      <div
        role="menu"
        className={`absolute z-40 grid gap-0.5 rounded-2xl bg-surface p-1.5 shadow-[var(--shadow-lg)] ring-1 ring-border-subtle ${className}`}
      >
        {emojis.map((emoji) => (
          <button
            key={emoji}
            type="button"
            role="menuitem"
            onClick={() => onPick(emoji)}
            className={`inline-flex size-9 items-center justify-center rounded-full text-xl transition-transform hover:scale-125 hover:bg-surface-sunken ${
              chosen === emoji ? 'bg-surface-sunken ring-1 ring-border-base' : ''
            }`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </>
  );
}

/** Words with what was looked for marked, as a search in WhatsApp shows it. */
export function Marked({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="rounded bg-yellow-300/80 px-0.5 text-inherit dark:bg-yellow-500/50">
        {text.slice(at, at + term.length)}
      </mark>,
    );
    from = at + term.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

/** A photo opened over everything, as tapping one in WhatsApp does. */
export function Lightbox({ src, onClose, label }: { src: string | null; onClose: () => void; label: string }) {
  useEffect(() => {
    if (!src) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [src, onClose]);
  if (!src) return null;
  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/90" role="dialog" aria-modal="true" aria-label={label}>
      <div className="flex shrink-0 items-center justify-end gap-1 p-2">
        <a
          href={src}
          download
          aria-label="download"
          className="inline-flex size-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
        >
          <Download className="size-5" />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          className="inline-flex size-11 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white"
        >
          <X className="size-6" />
        </button>
      </div>
      <button type="button" className="flex min-h-0 flex-1 items-center justify-center p-3" onClick={onClose} aria-label="close">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={label} className="max-h-full max-w-full rounded object-contain" onClick={(event) => event.stopPropagation()} />
      </button>
    </div>
  );
}

/** One photo of a conversation, as the viewer pages through them. */
export interface ViewerPhoto {
  src: string;
  /** The message it came in, to go back to. */
  messageId?: string;
  author?: string | null;
  at?: string;
  caption?: string;
}

export interface ViewerWords {
  photo: string;
  goTo: string;
  zoomIn: string;
  zoomOut: string;
  rotate: string;
  previous: string;
  next: string;
  close: string;
  save: string;
}

const viewerDate = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

/**
 * The conversation's photos opened over everything, as WhatsApp's viewer: who
 * sent it and when, page through them by arrows, keys or a swipe, zoom in by a
 * tap, the wheel or the buttons and drag about, turn it, save it, see the strip
 * of all of them, and go back to the message it came in.
 */
export function PhotoViewer({
  photos,
  index,
  onIndex,
  onClose,
  onGoTo,
  words,
}: {
  photos: ViewerPhoto[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onGoTo?: (messageId: string) => void;
  words: ViewerWords;
}) {
  const photo = photos[index];
  const [zoom, setZoom] = useState(1);
  const [turn, setTurn] = useState(0);
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number }; moved: boolean } | null>(null);
  const swipe = useRef<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

  // Each photo opens whole and unturned, its thumbnail brought into view.
  useEffect(() => {
    setZoom(1);
    setTurn(0);
    setShift({ x: 0, y: 0 });
    setLoaded(false);
    strip.current
      ?.querySelector(`[data-at="${index}"]`)
      ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [index]);

  const go = useCallback(
    (step: number) => {
      const next = index + step;
      if (next >= 0 && next < photos.length) onIndex(next);
    },
    [index, photos.length, onIndex],
  );

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      // The next is the one after in reading order: to the left in Arabic.
      else if (event.key === 'ArrowLeft') go(rtl ? 1 : -1);
      else if (event.key === 'ArrowRight') go(rtl ? -1 : 1);
      else if (event.key === '+' || event.key === '=') setZoom((value) => Math.min(4, value + 0.5));
      else if (event.key === '-') setZoom((value) => Math.max(1, value - 0.5));
    };
    window.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
    };
  }, [go, onClose, rtl]);

  // Back to whole: back in the middle too.
  useEffect(() => {
    if (zoom === 1) setShift({ x: 0, y: 0 });
  }, [zoom]);

  if (!photo) return null;
  const iconButton =
    'inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white/80 transition hover:bg-white/10 hover:text-white disabled:opacity-30';
  const canGo = Boolean(onGoTo && photo.messageId);

  return (
    <div
      className="fixed inset-0 z-[70] flex select-none flex-col bg-black/95 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={words.photo}
    >
      {/* Who sent it, when, and what can be done to it. */}
      <div className="flex shrink-0 items-center gap-1 bg-gradient-to-b from-black/70 to-transparent px-2 py-2 sm:gap-2 sm:px-4">
        <button type="button" onClick={onClose} aria-label={words.close} title={words.close} className={iconButton}>
          <X className="size-6" />
        </button>
        <div className="min-w-0 flex-1 px-1 text-white">
          <p className="truncate text-sm font-semibold">{photo.author || words.photo}</p>
          <p className="truncate text-xs text-white/60 tabular-nums">
            <span dir="ltr">{photo.at ? viewerDate(photo.at) : ''}</span>
            {photos.length > 1 && (
              <span dir="ltr" className="ms-2 rounded-full bg-white/10 px-1.5 py-px text-[11px] text-white/80">
                {index + 1} / {photos.length}
              </span>
            )}
          </p>
        </div>
        {canGo && (
          <button
            type="button"
            onClick={() => onGoTo!(photo.messageId!)}
            aria-label={words.goTo}
            title={words.goTo}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2.5 text-xs font-semibold text-white transition hover:bg-white/20 sm:px-3"
          >
            <MessageSquareShare className="size-4" />
            <span className="hidden sm:inline">{words.goTo}</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
          disabled={zoom <= 1}
          aria-label={words.zoomOut}
          title={words.zoomOut}
          className={`${iconButton} max-sm:hidden`}
        >
          <ZoomOut className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(4, value + 0.5))}
          disabled={zoom >= 4}
          aria-label={words.zoomIn}
          title={words.zoomIn}
          className={`${iconButton} max-sm:hidden`}
        >
          <ZoomIn className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => setTurn((value) => value + 90)}
          aria-label={words.rotate}
          title={words.rotate}
          className={iconButton}
        >
          <RotateCw className="size-5" />
        </button>
        <a href={photo.src} download aria-label={words.save} title={words.save} className={iconButton}>
          <Download className="size-5" />
        </a>
      </div>

      {/* The photo itself: a tap zooms, a drag moves it when zoomed, a swipe pages. */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        onWheel={(event) =>
          setZoom((value) => Math.min(4, Math.max(1, value - Math.sign(event.deltaY) * 0.25)))
        }
        onTouchStart={(event) => {
          swipe.current = zoom === 1 && event.touches.length === 1 ? event.touches[0]!.clientX : null;
        }}
        onTouchEnd={(event) => {
          const start = swipe.current;
          swipe.current = null;
          if (start === null) return;
          const moved = event.changedTouches[0]!.clientX - start;
          // A swipe towards the start brings the next, as the pages turn.
          if (Math.abs(moved) > 60) go(moved < 0 !== rtl ? 1 : -1);
        }}
      >
        {!loaded && (
          <span className="pointer-events-none absolute size-10 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={photo.src}
          src={photo.src}
          alt={photo.caption || words.photo}
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, y: event.clientY, from: shift, moved: false };
            event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerMove={(event) => {
            const held = drag.current;
            if (!held) return;
            const dx = event.clientX - held.x;
            const dy = event.clientY - held.y;
            if (!held.moved && Math.abs(dx) + Math.abs(dy) > 6) {
              held.moved = true;
              setDragging(true);
            }
            if (zoom > 1 && held.moved) setShift({ x: held.from.x + dx, y: held.from.y + dy });
          }}
          onPointerUp={() => {
            const held = drag.current;
            drag.current = null;
            setDragging(false);
            if (held && !held.moved) setZoom((value) => (value > 1 ? 1 : 2.5));
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          style={{
            transform: `translate(${shift.x}px, ${shift.y}px) scale(${zoom}) rotate(${turn}deg)`,
            transition: dragging ? 'none' : 'transform 180ms ease, opacity 200ms ease',
            opacity: loaded ? 1 : 0,
            cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
            touchAction: zoom > 1 ? 'none' : 'pan-y',
          }}
          className="max-h-full max-w-full object-contain p-2 sm:p-6"
        />
        {photos.length > 1 && (
          <>
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={index === 0}
              aria-label={words.previous}
              title={words.previous}
              className="absolute start-3 top-1/2 inline-flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 disabled:pointer-events-none disabled:opacity-0 max-sm:hidden"
            >
              <ChevronRight className="size-7 ltr:rotate-180" />
            </button>
            <button
              type="button"
              onClick={() => go(1)}
              disabled={index === photos.length - 1}
              aria-label={words.next}
              title={words.next}
              className="absolute end-3 top-1/2 inline-flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20 disabled:pointer-events-none disabled:opacity-0 max-sm:hidden"
            >
              <ChevronLeft className="size-7 ltr:rotate-180" />
            </button>
          </>
        )}
      </div>

      {/* Its words, and every photo of the conversation in a strip. */}
      <div className="shrink-0 bg-gradient-to-t from-black/80 to-transparent pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {photo.caption && (
          <p className="mx-auto line-clamp-3 max-w-2xl whitespace-pre-wrap break-words px-4 pb-2 text-center text-sm text-white/90">
            {photo.caption}
          </p>
        )}
        {photos.length > 1 && (
          <div ref={strip} className="overflow-x-auto px-3 pb-1 pt-1 [scrollbar-width:none]">
            <div className="mx-auto flex w-max gap-1.5">
              {photos.map((entry, at) => (
                <button
                  key={`${entry.src}-${at}`}
                  type="button"
                  data-at={at}
                  onClick={() => onIndex(at)}
                  className={`size-14 shrink-0 overflow-hidden rounded-md transition ${
                    at === index ? 'scale-105 opacity-100 ring-2 ring-white' : 'opacity-50 hover:opacity-90'
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={entry.src} alt="" loading="lazy" className="size-full object-cover" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
