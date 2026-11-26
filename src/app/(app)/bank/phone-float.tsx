'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Layers, Minimize2, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';

/**
 * The floating window on a phone. A phone's browser draws nothing of a site
 * over another app, so it is two things there:
 *
 * - a card floating inside the program, dragged anywhere and folded into a
 *   bubble, with everything the desktop window has — copy, the receipt, sent;
 * - a picture-in-picture window, which the phone does keep above the bank's
 *   app: the transfer's details drawn large to read from while typing them
 *   there. Nothing in it can be pressed or copied — the phone allows a video
 *   there, nothing more.
 */

/** No window of its own can be opened here: a phone or tablet's browser. */
export function wantsPhoneFloat(): boolean {
  if (typeof window === 'undefined') return false;
  if ('documentPictureInPicture' in window) return false;
  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
}

/** What the window above the bank's app shows. */
export interface OverlayCard {
  name: string | null;
  account: string | null;
  amount: string;
  currency: string;
  /** Paid in parts: what is left, sent next. */
  left: string | null;
  channel: string | null;
  reference: string;
  /** The words beside each line. */
  words: { account: string; amount: string; left: string; channel: string };
}

const W = 720;
const H = 480;

/** The card drawn on the canvas the video plays. */
function draw(canvas: HTMLCanvasElement, card: OverlayCard, rtl: boolean) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(1, '#13233f');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const pad = 36;
  const start = rtl ? W - pad : pad;
  const end = rtl ? pad : W - pad;
  const text = (value: string, x: number, y: number, size: number, colour: string, weight = 600, align: 'start' | 'end' | 'center' = 'start', direction: 'rtl' | 'ltr' | 'inherit' = 'inherit') => {
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = colour;
    ctx.direction = direction === 'inherit' ? (rtl ? 'rtl' : 'ltr') : direction;
    ctx.textAlign = align === 'center' ? 'center' : align === 'start' ? (rtl ? 'right' : 'left') : rtl ? 'left' : 'right';
    ctx.textBaseline = 'alphabetic';
    let shown = value;
    const room = W - pad * 2;
    while (shown.length > 1 && ctx.measureText(shown).width > room) shown = shown.slice(0, -2) + '…';
    ctx.fillText(shown, x, y);
  };

  // Who it goes to, and the reference.
  text(card.name || card.account || '', start, 70, 38, '#f8fafc', 800);
  text(card.reference, start, 104, 22, '#94a3b8', 500);

  // The account, large: what is typed into the bank's app.
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.beginPath();
  ctx.roundRect(pad - 8, 128, W - pad * 2 + 16, 132, 22);
  ctx.fill();
  text(card.words.account, start, 166, 22, '#94a3b8', 600);
  text(card.account || '—', W / 2, 236, 62, '#ffffff', 800, 'center', 'ltr');

  // The sum, or what is left of it.
  const sum = card.left ?? card.amount;
  text(card.left ? card.words.left : card.words.amount, start, 312, 22, '#94a3b8', 600);
  text(`${sum} ${card.currency}`, start, 372, 56, card.left ? '#fbbf24' : '#34d399', 800, 'start', 'ltr');
  if (card.left) text(`${card.amount} ${card.currency}`, end, 372, 24, '#64748b', 600, 'end', 'ltr');

  if (card.channel) text(`${card.words.channel}: ${card.channel}`, start, 430, 24, '#cbd5e1', 600);
  ctx.fillStyle = '#10b981';
  ctx.fillRect(0, H - 8, W, 8);
}

/**
 * The window above the bank's app: a canvas played as a video, ready from the
 * moment the card opens, so the press that asks for it still counts as one —
 * Safari refuses one asked for after anything waited on.
 */
function useOverlay(card: OverlayCard | null) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [on, setOn] = useState(false);
  const [supported, setSupported] = useState(true);
  const cardRef = useRef(card);
  cardRef.current = card;
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

  useEffect(() => {
    if (!card) return;
    const paper = document.createElement('canvas');
    paper.width = W;
    paper.height = H;
    const capture = (paper as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
    const player = document.createElement('video');
    if (!capture || !('requestPictureInPicture' in player || 'webkitSetPresentationMode' in player)) {
      setSupported(false);
      return;
    }
    draw(paper, card, rtl);
    player.muted = true;
    player.playsInline = true;
    player.setAttribute('playsinline', '');
    player.setAttribute('muted', '');
    // Safari: it goes above the other apps by itself when the bank's is opened.
    player.setAttribute('autopictureinpicture', '');
    player.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0;pointer-events:none;bottom:0;left:0';
    player.srcObject = capture.call(paper, 2);
    document.body.appendChild(player);
    void player.play().catch(() => undefined);
    const enter = () => setOn(true);
    const leave = () => setOn(false);
    player.addEventListener('enterpictureinpicture', enter);
    player.addEventListener('leavepictureinpicture', leave);
    player.addEventListener('webkitpresentationmodechanged', () =>
      setOn((player as unknown as { webkitPresentationMode?: string }).webkitPresentationMode === 'picture-in-picture'),
    );
    // Drawn again and again: a still canvas stops its stream, and the window goes black.
    const timer = setInterval(() => cardRef.current && draw(paper, cardRef.current, rtl), 500);
    canvas.current = paper;
    video.current = player;
    return () => {
      clearInterval(timer);
      if (document.pictureInPictureElement === player) void document.exitPictureInPicture().catch(() => undefined);
      player.removeEventListener('enterpictureinpicture', enter);
      player.removeEventListener('leavepictureinpicture', leave);
      (player.srcObject as MediaStream | null)?.getTracks().forEach((track) => track.stop());
      player.remove();
      canvas.current = null;
      video.current = null;
      setOn(false);
    };
    // Opened once per card; its words are drawn afresh from the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(card)]);

  const toggle = (): boolean => {
    const player = video.current;
    if (!player) return false;
    if (on) {
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
      else (player as unknown as { webkitSetPresentationMode?: (mode: string) => void }).webkitSetPresentationMode?.('inline');
      return true;
    }
    void player.play().catch(() => undefined);
    try {
      if ('requestPictureInPicture' in player && document.pictureInPictureEnabled !== false) {
        player.requestPictureInPicture().catch(() => {
          const webkit = (player as unknown as { webkitSetPresentationMode?: (mode: string) => void }).webkitSetPresentationMode;
          if (webkit) webkit.call(player, 'picture-in-picture');
          else setSupported(false);
        });
      } else {
        (player as unknown as { webkitSetPresentationMode: (mode: string) => void }).webkitSetPresentationMode('picture-in-picture');
      }
      return true;
    } catch {
      setSupported(false);
      return false;
    }
  };

  return { on, supported, toggle };
}

/** The card floating inside the program, dragged anywhere, folded into a bubble. */
export function PhoneFloat({
  open,
  title,
  subtitle,
  badge,
  card,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  /** What the folded bubble shows: the sum. */
  badge: ReactNode;
  card: OverlayCard | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useLocale();
  const [small, setSmall] = useState(false);
  /** Where it sits, from the bottom-left corner of the screen; null while at its own place. */
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  const held = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const overlay = useOverlay(open ? card : null);

  useEffect(() => {
    if (open) {
      setSmall(false);
      setSpot(null);
    }
  }, [open]);

  if (!open) return null;

  const keepIn = (x: number, y: number) => {
    const node = box.current;
    const width = node?.offsetWidth ?? 60;
    const height = node?.offsetHeight ?? 60;
    return {
      x: Math.min(Math.max(8, x), window.innerWidth - width - 8),
      y: Math.min(Math.max(8, y), window.innerHeight - height - 8),
    };
  };
  const grab = (event: React.PointerEvent) => {
    const node = box.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    held.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };
  const move = (event: React.PointerEvent) => {
    const hold = held.current;
    const node = box.current;
    if (!hold || !node) return;
    const left = event.clientX - hold.dx;
    const top = event.clientY - hold.dy;
    if (!hold.moved && spot) {
      const rect = node.getBoundingClientRect();
      if (Math.abs(rect.left - left) + Math.abs(rect.top - top) < 6) return;
    }
    hold.moved = true;
    setSpot(keepIn(left, top));
  };
  const drop = () => {
    const hold = held.current;
    held.current = null;
    // A tap on the bubble opens it; a drag only moves it.
    if (small && hold && !hold.moved) setSmall(false);
  };

  const place = spot ? { left: spot.x, top: spot.y } : undefined;
  const iconButton =
    'inline-flex size-8 shrink-0 items-center justify-center rounded-full text-content-secondary transition hover:bg-surface-sunken hover:text-content';

  if (small) {
    return (
      <div
        ref={box}
        role="button"
        tabIndex={0}
        aria-label={title}
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={drop}
        onKeyDown={(event) => event.key === 'Enter' && setSmall(false)}
        style={place}
        className={`fixed z-[65] flex touch-none select-none items-center gap-2 rounded-full bg-primary py-2 pe-4 ps-2 text-white shadow-[0_10px_30px_-8px_rgba(0,0,0,0.45)] ring-4 ring-white/70 dark:ring-black/40 ${
          spot ? '' : 'bottom-[calc(1rem+env(safe-area-inset-bottom))] end-4'
        }`}
      >
        <span className="relative inline-flex size-9 items-center justify-center rounded-full bg-white/20">
          <Layers className="size-4.5" />
          {overlay.on && <span className="absolute -end-0.5 -top-0.5 size-3 rounded-full bg-emerald-400 ring-2 ring-primary" />}
        </span>
        <span dir="ltr" className="text-sm font-extrabold tabular-nums">{badge}</span>
      </div>
    );
  }

  return (
    <div
      ref={box}
      role="dialog"
      aria-label={title}
      style={place}
      className={`fixed z-[65] flex max-h-[85dvh] w-[min(24rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_24px_60px_-12px_rgba(0,0,0,0.5)] ring-1 ring-border-subtle ${
        spot ? '' : 'inset-x-2 bottom-[calc(0.5rem+env(safe-area-inset-bottom))] mx-auto'
      }`}
    >
      {/* The handle: dragged to move it anywhere on the screen. */}
      <div
        onPointerDown={grab}
        onPointerMove={move}
        onPointerUp={drop}
        className="flex touch-none cursor-grab select-none items-center gap-2 border-b border-border-subtle bg-surface-sunken/60 px-2 py-1.5 active:cursor-grabbing"
      >
        <span aria-hidden className="mx-1 h-1 w-6 shrink-0 rounded-full bg-border-strong" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-bold text-content">{title}</span>
          <span className="block truncate text-[11px] text-content-tertiary">{subtitle}</span>
        </span>
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => setSmall(true)} aria-label={t('bankSent.minimize')} title={t('bankSent.minimize')} className={iconButton}>
          <Minimize2 className="size-4" />
        </button>
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={onClose} aria-label={t('common.close')} title={t('common.close')} className={iconButton}>
          <X className="size-4.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2.5">
        {/* Above the bank's app: the details to read from there. */}
        {overlay.supported && card && (
          <button
            type="button"
            onClick={() => {
              const opened = !overlay.on;
              if (overlay.toggle() && opened) setSmall(true);
            }}
            className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start transition ${
              overlay.on
                ? 'bg-success-subtle/60 ring-1 ring-success/30'
                : 'bg-gradient-to-l from-primary/10 to-primary/5 ring-1 ring-primary/25 hover:from-primary/15'
            }`}
          >
            <span
              className={`inline-flex size-9 shrink-0 items-center justify-center rounded-lg ${
                overlay.on ? 'bg-success text-white' : 'bg-primary text-white'
              }`}
            >
              <Layers className="size-4.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-bold text-content">
                {overlay.on ? t('bankSent.overlayOn') : t('bankSent.overlay')}
              </span>
              <span className="block text-[11px] leading-snug text-content-tertiary">
                {overlay.on ? t('bankSent.overlayOff') : t('bankSent.overlayHint')}
              </span>
            </span>
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
