'use client';

import { useEffect, useRef, useState } from 'react';

/** A short tone when a customer writes. Silent where the browser will not play it. */
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
    // Sound is a nicety; the count beside the inbox shows it regardless.
  }
}

/**
 * How many customer messages wait unread for this person — the private number's
 * and their own number's — read every few seconds on whatever page they are on,
 * with a tone when more arrive. Nothing is asked while the tab is hidden; it
 * catches up when shown, and only then sounds.
 */
export function useInboxUnread(enabled: boolean): number {
  const [count, setCount] = useState(0);
  const last = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const read = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch('/api/inbox/unread', { cache: 'no-store' });
        if (!response.ok || stopped) return;
        // Only the person's own number: the private number's conversations are not on the screen.
        const body = (await response.json()) as { data?: { mine?: number }; mine?: number };
        const total = body.data?.mine ?? body.mine ?? 0;
        if (last.current !== null && total > last.current) chime();
        last.current = total;
        setCount(total);
      } catch {
        // Offline for a moment: the next reading catches up.
      }
    };
    void read();
    const timer = setInterval(() => void read(), 15_000);
    const shown = () => void read();
    document.addEventListener('visibilitychange', shown);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [enabled]);

  return count;
}
