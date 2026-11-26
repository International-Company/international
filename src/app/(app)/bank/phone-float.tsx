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

/** Wide, as a phone draws its floating windows: 16 by 9, drawn at twice their size. */
const W = 960;
const H = 540;

/** The account in groups, as it is read off and typed: the digits themselves unchanged. */
function grouped(account: string): string {
  const plain = account.replace(/\s+/g, '');
  if (!/^[0-9]+$/.test(plain) || plain.length < 7) return account;
  // Fours when they divide it (a card, an IBAN); else threes, the last ones a digit longer: 059 900 0111.
  const sizes =
    plain.length % 4 === 0
      ? Array.from({ length: plain.length / 4 }, () => 4)
      : Array.from({ length: Math.floor(plain.length / 3) }, (_, at) =>
          at >= Math.floor(plain.length / 3) - (plain.length % 3) ? 4 : 3,
        );
  const parts: string[] = [];
  let at = 0;
  for (const size of sizes) {
    parts.push(plain.slice(at, at + size));
    at += size;
  }
  return parts.join(' ');
}

/** The card drawn on the canvas the video plays: what is typed into the bank's app, large. */
function draw(canvas: HTMLCanvasElement, card: OverlayCard, rtl: boolean) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';

  // The ground: deep blue, lit from one corner.
  const ground = ctx.createLinearGradient(0, 0, W, H);
  ground.addColorStop(0, '#0b1220');
  ground.addColorStop(1, '#111c33');
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(rtl ? W : 0, 0, 0, rtl ? W : 0, 0, W * 0.8);
  glow.addColorStop(0, 'rgba(37, 99, 235, 0.28)');
  glow.addColorStop(1, 'rgba(37, 99, 235, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const pad = 44;
  const start = rtl ? W - pad : pad;
  const end = rtl ? pad : W - pad;
  const text = (
    value: string,
    x: number,
    y: number,
    size: number,
    colour: string,
    options: { weight?: number; align?: 'start' | 'end' | 'center'; ltr?: boolean; room?: number; spacing?: number } = {},
  ) => {
    const { weight = 700, align = 'start', ltr = false, room = W - pad * 2, spacing = 0 } = options;
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.fillStyle = colour;
    ctx.direction = ltr ? 'ltr' : rtl ? 'rtl' : 'ltr';
    ctx.textAlign = align === 'center' ? 'center' : (align === 'start') === rtl ? 'right' : 'left';
    ctx.textBaseline = 'alphabetic';
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${spacing}px`;
    let shown = value;
    while (shown.length > 1 && ctx.measureText(shown).width > room) shown = shown.slice(0, -2) + '…';
    ctx.fillText(shown, x, y);
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px';
    return ctx.measureText(shown).width;
  };

  // Top: who it goes to, and by which bank.
  text(card.name || card.reference, start, 78, 44, '#f8fafc', { weight: 800, room: W * 0.6 });
  if (card.channel) {
    ctx.font = `700 26px ${font}`;
    const width = Math.min(ctx.measureText(card.channel).width + 40, W * 0.3);
    const left = rtl ? pad : W - pad - width;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.roundRect(left, 40, width, 50, 25);
    ctx.fill();
    text(card.channel, left + width / 2, 75, 26, '#e2e8f0', { align: 'center', room: width - 24 });
  }
  text(card.reference, start, 116, 22, '#64748b', { weight: 600, ltr: true, align: 'start' });

  // Middle: the account, the largest thing on it.
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(pad - 10, 146, W - pad * 2 + 20, 176, 28);
  ctx.fill();
  ctx.stroke();
  text(card.words.account, start + (rtl ? -18 : 18), 190, 24, '#94a3b8', { weight: 600 });
  text(grouped(card.account || '—'), W / 2, 284, 92, '#ffffff', { weight: 800, align: 'center', ltr: true, spacing: 3 });

  // Bottom: the sum, or what is left of it.
  const sum = card.left ?? card.amount;
  const colour = card.left ? '#fbbf24' : '#34d399';
  text(card.left ? card.words.left : card.words.amount, start, 372, 24, '#94a3b8', { weight: 600 });
  text(`${sum} ${card.currency}`, start, 450, 76, colour, { weight: 800, align: 'start', ltr: true, room: W * 0.62 });
  if (card.left) {
    text(`${card.words.amount}: ${card.amount} ${card.currency}`, end, 450, 26, '#64748b', { weight: 600, align: 'end' });
  }

  // The program's mark along the foot.
  const foot = ctx.createLinearGradient(0, 0, W, 0);
  foot.addColorStop(0, '#10b981');
  foot.addColorStop(1, '#2563eb');
  ctx.fillStyle = foot;
  ctx.fillRect(0, H - 10, W, 10);
}

type Webkit = HTMLVideoElement & {
  webkitSetPresentationMode?: (mode: 'inline' | 'picture-in-picture') => void;
  webkitPresentationMode?: string;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
};

/**
 * The window above the bank's app: a canvas played as a video. Asked for at
 * once when the card opens — the press on "floating window" still counts —
 * and, where the browser offers it, again by itself whenever the program is
 * left for another app. Where neither is allowed, a press on the card's button.
 */
function useOverlay(card: OverlayCard | null, autoStart: boolean) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [on, setOn] = useState(false);
  const [supported, setSupported] = useState(true);
  /** Asked for by itself and refused: the card asks for a press instead. */
  const [needsPress, setNeedsPress] = useState(false);
  const cardRef = useRef(card);
  cardRef.current = card;
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';

  const enterWith = (player: Webkit): Promise<void> => {
    void player.play().catch(() => undefined);
    if (typeof player.requestPictureInPicture === 'function' && document.pictureInPictureEnabled !== false) {
      return player.requestPictureInPicture().then(
        () => undefined,
        (error) => {
          if (player.webkitSetPresentationMode) player.webkitSetPresentationMode('picture-in-picture');
          else throw error;
        },
      );
    }
    if (player.webkitSetPresentationMode) {
      player.webkitSetPresentationMode('picture-in-picture');
      return Promise.resolve();
    }
    return Promise.reject(new Error('unsupported'));
  };

  useEffect(() => {
    if (!card) return;
    const paper = document.createElement('canvas');
    paper.width = W;
    paper.height = H;
    const capture = (paper as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
    const player = document.createElement('video') as Webkit;
    if (!capture || !(typeof player.requestPictureInPicture === 'function' || player.webkitSetPresentationMode)) {
      setSupported(false);
      return;
    }
    draw(paper, card, rtl);
    player.muted = true;
    player.playsInline = true;
    player.autoplay = true;
    player.setAttribute('playsinline', '');
    player.setAttribute('muted', '');
    // Safari: above the other apps by itself, when the program is left.
    player.setAttribute('autopictureinpicture', '');
    // Kept on the page, tiny and faint: some browsers will not float a video nobody can see.
    player.style.cssText =
      'position:fixed;width:4px;height:4px;opacity:0.01;pointer-events:none;bottom:0;left:0;z-index:-1';
    player.srcObject = capture.call(paper, 5);
    document.body.appendChild(player);
    void player.play().catch(() => undefined);

    const enter = () => {
      setOn(true);
      setNeedsPress(false);
    };
    const leave = () => setOn(false);
    const webkitChange = () => setOn(player.webkitPresentationMode === 'picture-in-picture');
    player.addEventListener('enterpictureinpicture', enter);
    player.addEventListener('leavepictureinpicture', leave);
    player.addEventListener('webkitpresentationmodechanged', webkitChange);

    // Chrome: floated by itself when the program is left, as a video call is.
    const session = 'mediaSession' in navigator ? navigator.mediaSession : null;
    try {
      session?.setActionHandler('enterpictureinpicture' as MediaSessionAction, () => void enterWith(player).catch(() => undefined));
    } catch {
      // An older browser: the press is the way.
    }
    if (session && 'MediaMetadata' in window) {
      try {
        session.metadata = new MediaMetadata({
          title: card.name ?? card.account ?? card.reference,
          artist: `${card.left ?? card.amount} ${card.currency}`,
          album: card.channel ?? '',
        });
      } catch {
        // Only the words under it.
      }
    }

    // Asked for at once, while the press that opened the card still counts.
    let cancelled = false;
    if (autoStart) {
      const go = () => {
        if (cancelled) return;
        enterWith(player).catch(() => !cancelled && setNeedsPress(true));
      };
      if (player.readyState >= 1) go();
      else player.addEventListener('loadedmetadata', go, { once: true });
    }

    // Drawn again and again: a still canvas stops its stream, and the window goes black.
    const timer = setInterval(() => cardRef.current && draw(paper, cardRef.current, rtl), 400);
    video.current = player;
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (document.pictureInPictureElement === player) void document.exitPictureInPicture().catch(() => undefined);
      else if (player.webkitPresentationMode === 'picture-in-picture') player.webkitSetPresentationMode?.('inline');
      try {
        session?.setActionHandler('enterpictureinpicture' as MediaSessionAction, null);
        if (session) session.metadata = null;
      } catch {
        // Nothing was set.
      }
      player.removeEventListener('enterpictureinpicture', enter);
      player.removeEventListener('leavepictureinpicture', leave);
      player.removeEventListener('webkitpresentationmodechanged', webkitChange);
      (player.srcObject as MediaStream | null)?.getTracks().forEach((track) => track.stop());
      player.remove();
      video.current = null;
      setOn(false);
      setNeedsPress(false);
    };
    // Opened once per card; its words are drawn afresh from the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(card)]);

  const toggle = (): boolean => {
    const player = video.current as Webkit | null;
    if (!player) return false;
    if (on) {
      if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
      else player.webkitSetPresentationMode?.('inline');
      return true;
    }
    enterWith(player).catch(() => setSupported(false));
    return true;
  };

  return { on, supported, needsPress, toggle };
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
  const overlay = useOverlay(open ? card : null, true);

  useEffect(() => {
    if (open) {
      setSmall(false);
      setSpot(null);
    }
  }, [open]);

  // Floating above the other apps: the card here folds out of the way.
  useEffect(() => {
    if (overlay.on) setSmall(true);
  }, [overlay.on]);

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
                : overlay.needsPress
                  ? 'animate-pulse bg-primary/15 ring-2 ring-primary'
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
                {overlay.on ? t('bankSent.overlayOn') : overlay.needsPress ? t('bankSent.overlayPress') : t('bankSent.overlay')}
              </span>
              <span className="block text-[11px] leading-snug text-content-tertiary">
                {overlay.on ? t('bankSent.overlayOff') : t('bankSent.overlayHint')}
              </span>
            </span>
          </button>
        )}
        {!overlay.supported && (
          <p className="rounded-xl bg-warning-subtle/60 px-3 py-2 text-[11px] leading-relaxed text-warning-text">
            {t('bankSent.overlayUnsupported')}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
