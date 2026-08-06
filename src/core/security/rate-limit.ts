import 'server-only';

/**
 * Fixed-window rate limiter held in process memory.
 *
 * Deliberately simple: it protects login and other sensitive endpoints from
 * automated abuse on a single-node deployment, which is how exchange offices
 * actually run this software. Behind a load balancer this should be swapped for
 * a shared store — the interface is designed so only this file changes.
 */

interface Window {
  count: number;
  resetAt: number;
}

const globalForLimiter = globalThis as unknown as { __ifmsRateLimiter?: Map<string, Window> };
const windows: Map<string, Window> = globalForLimiter.__ifmsRateLimiter ?? new Map();
globalForLimiter.__ifmsRateLimiter = windows;

let lastSweep = 0;

/** Drops expired windows so the map cannot grow without bound. */
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAt: Date;
}

export function checkRateLimit(
  key: string,
  options: { limit: number; windowSeconds: number },
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = windows.get(key);
  const window: Window =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + options.windowSeconds * 1000 };

  window.count++;
  windows.set(key, window);

  const allowed = window.count <= options.limit;
  return {
    allowed,
    remaining: Math.max(0, options.limit - window.count),
    retryAfterSeconds: allowed ? 0 : Math.ceil((window.resetAt - now) / 1000),
    resetAt: new Date(window.resetAt),
  };
}

/** Clears a window after a successful attempt so honest users are not penalised. */
export function resetRateLimit(key: string): void {
  windows.delete(key);
}

export const RATE_LIMITS = {
  login: { limit: 10, windowSeconds: 300 },
  loginPerAccount: { limit: 5, windowSeconds: 300 },
  passwordChange: { limit: 5, windowSeconds: 900 },
  twoFactor: { limit: 8, windowSeconds: 300 },
  export: { limit: 30, windowSeconds: 300 },
  walletSync: { limit: 20, windowSeconds: 300 },
  mutation: { limit: 240, windowSeconds: 60 },
} as const;
