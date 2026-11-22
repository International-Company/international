'use client';

import { useEffect, type ReactNode } from 'react';
import { Check, CheckCheck, Clock, Download, Users, X } from 'lucide-react';

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
