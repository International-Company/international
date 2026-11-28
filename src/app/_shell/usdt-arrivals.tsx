'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { CheckCircle2, Coins, FileSearch, Timer, X } from 'lucide-react';
import { useLocale } from '@/i18n/provider';
import { networkLabel } from '@/lib/network-label';
import { Money } from '@/ui/display';
import { Button } from '@/ui/primitives';
import { TxDetailDialog } from '../(app)/counter/usdt/tx-detail';

interface Landed {
  id: string;
  txHash: string;
  amount: string;
  confirmations: number;
  required: number;
  ready: boolean;
  firstSeenAt: string;
  fromAddress: string | null;
  /** The coin that came, when a Binance account took another than the wallet's. */
  coin?: string;
  wallet: { id: string; label: string; labelAr: string; network: string; tokenSymbol: string };
}

/** How often the counter's addresses are asked, on whatever page the teller is. */
const POLL_MS = 7_000;
/** What this browser has already been told of, so a reload does not ring for it again. */
const SEEN_KEY = 'ifms.usdt.seen';
/** An arrival this old when the page first opens was missed, not just landed: it is not rung for. */
const FRESH_MS = 10 * 60_000;

/** Two rising notes: money, not a message. Silent where the browser will not play it. */
function ring() {
  try {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const context = new Context();
    [660, 990].forEach((frequency, index) => {
      const tone = context.createOscillator();
      const level = context.createGain();
      const at = context.currentTime + index * 0.18;
      tone.frequency.value = frequency;
      level.gain.setValueAtTime(0.14, at);
      level.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
      tone.connect(level).connect(context.destination);
      tone.start(at);
      tone.stop(at + 0.3);
      if (index === 1) tone.onended = () => void context.close();
    });
  } catch {
    // Sound is a nicety; the card shows it regardless.
  }
}

const readSeen = (): Set<string> => {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};
const keepSeen = (seen: Set<string>) => {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-300)));
  } catch {
    // Blocked storage: this tab still remembers.
  }
};

/**
 * USDT landing on a counter address, told the moment it does — a card and a
 * tone on any page — with the transfer one press from being recorded or
 * opened as an explorer shows it. The USDT counter itself already lists them,
 * so nothing is asked there.
 */
export function UsdtArrivalAlert({ enabled }: { enabled: boolean }) {
  const { t, ln } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [cards, setCards] = useState<Landed[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const onCounter = pathname.startsWith('/counter/usdt');

  useEffect(() => {
    if (!enabled || onCounter) return;
    let stopped = false;
    let busy = false;
    const read = async () => {
      if (document.hidden || busy) return;
      busy = true;
      try {
        const response = await fetch('/api/usdt/arrivals', { cache: 'no-store' });
        if (!response.ok || stopped) return;
        const body = (await response.json()) as { data?: Landed[] } | Landed[];
        const rows = (Array.isArray(body) ? body : body.data) ?? [];
        const first = seen.current === null;
        seen.current ??= readSeen();
        const known = seen.current;
        const landed = rows.filter(
          (row) => !known.has(row.id) && (!first || Date.now() - new Date(row.firstSeenAt).getTime() < FRESH_MS),
        );
        for (const row of rows) known.add(row.id);
        keepSeen(known);
        setCards((current) => {
          // What is still waiting keeps its card, brought up to date; what was recorded goes.
          const live = current
            .map((card) => rows.find((row) => row.id === card.id))
            .filter((row): row is Landed => Boolean(row));
          return [...landed.filter((row) => !live.some((card) => card.id === row.id)), ...live];
        });
        if (landed.length > 0) ring();
      } catch {
        // Offline for a moment: the next reading catches up.
      } finally {
        busy = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), POLL_MS);
    const shown = () => void read();
    document.addEventListener('visibilitychange', shown);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [enabled, onCounter]);

  if (!enabled) return null;

  const record = (id: string) => {
    setCards((current) => current.filter((card) => card.id !== id));
    setDetailId(null);
    router.push(`/counter/usdt?d=in&arrival=${encodeURIComponent(id)}`);
  };
  const dismiss = (id: string) => setCards((current) => current.filter((card) => card.id !== id));

  const shown = onCounter ? [] : cards.slice(0, 3);

  return (
    <>
      {shown.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 end-4 z-[60] flex w-[min(23rem,calc(100vw-2rem))] flex-col gap-2 pb-[env(safe-area-inset-bottom)]">
          {cards.length > 3 && (
            <p className="pointer-events-auto self-start rounded-full bg-surface px-3 py-1 text-xs font-semibold text-content shadow-[var(--shadow-lg)] ring-1 ring-border-subtle">
              {t('chainTx.arrivedMore', { count: cards.length - 3 })}
            </p>
          )}
          {shown.map((card) => (
            <div
              key={card.id}
              role="status"
              className="pointer-events-auto overflow-hidden rounded-2xl border-s-4 border-s-success bg-surface shadow-[var(--shadow-lg)] ring-1 ring-border-subtle animate-in"
            >
              <div className="flex items-start gap-3 p-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success-subtle text-success-text">
                  <Coins className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-success-text">{t('chainTx.arrivedTitle')}</p>
                  <p className="text-xl font-extrabold tabular-nums text-content">
                    {card.coin && card.coin !== card.wallet.tokenSymbol ? (
                      <span className="ltr-content">
                        {(Number(BigInt(card.amount)) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 })} {card.coin}
                      </span>
                    ) : (
                      <Money value={card.amount} currency={card.wallet.tokenSymbol} />
                    )}
                  </p>
                  <p className="truncate text-xs text-content-tertiary">
                    {ln(card.wallet, 'label')} · {networkLabel(card.wallet.network)}
                  </p>
                  {card.fromAddress && (
                    <p className="text-[11px] text-content-tertiary">
                      {t('chainTx.from')}{' '}
                      <span className="ltr-content inline-block font-mono">
                        {card.fromAddress.slice(0, 8)}…{card.fromAddress.slice(-6)}
                      </span>
                    </p>
                  )}
                  <p className={card.ready ? 'mt-1 text-xs font-semibold text-success-text' : 'mt-1 text-xs font-semibold text-warning-text'}>
                    {card.ready ? (
                      <CheckCircle2 className="me-1 inline size-3.5" />
                    ) : (
                      <Timer className="me-1 inline size-3.5" />
                    )}
                    {card.ready
                      ? t('chainTx.confirmed', { confirmations: card.confirmations })
                      : t('chainTx.confirming', { confirmations: card.confirmations, required: card.required })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => dismiss(card.id)}
                  aria-label={t('chainTx.dismiss')}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-content-tertiary hover:bg-surface-sunken hover:text-content"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="flex gap-2 border-t border-border-subtle bg-surface-sunken/50 px-3 py-2">
                <Button size="sm" variant="ghost" icon={<FileSearch />} onClick={() => setDetailId(card.id)} className="flex-1">
                  {t('receive.details')}
                </Button>
                <Button size="sm" onClick={() => record(card.id)} className="flex-1">
                  {t('chainTx.record')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <TxDetailDialog id={detailId} onClose={() => setDetailId(null)} onRecord={(detail) => record(detail.id)} />
    </>
  );
}
