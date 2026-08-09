import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Class name composer. `clsx` handles conditionals, `twMerge` resolves Tailwind
 * conflicts so a caller's `px-6` reliably overrides a component's default `px-4`
 * instead of depending on stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Stable ids for label/description associations without hydration mismatch. */
let idCounter = 0;
export function nextId(prefix = 'ifms'): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

/** Semantic tone shared by badges, alerts and status pills. */
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

/** Maps a transaction status to the tone it should be rendered in. */
export function statusTone(status: string): Tone {
  switch (status) {
    case 'POSTED':
    case 'CONFIRMED':
    case 'COMPLETED':
    case 'VERIFIED':
    case 'ACTIVE':
    case 'OK':
    case 'CLOSED':
      return 'success';
    case 'PENDING':
    case 'PENDING_TRANSFER':
    case 'RUNNING':
    case 'CLOSING':
    case 'REOPENED':
      return 'warning';
    case 'REJECTED':
    case 'CANCELLED':
    case 'REVERSED':
    case 'FAILED':
    case 'CORRUPT':
    case 'LOCKED':
    case 'DISABLED':
    case 'ERROR':
    case 'ORPHANED':
      return 'danger';
    case 'DRAFT':
    case 'SUSPENDED':
    case 'NEVER':
      return 'neutral';
    case 'OPEN':
      return 'primary';
    default:
      return 'neutral';
  }
}

/** Amount colouring: money in is positive, money out is negative. */
export function amountTone(direction: 'IN' | 'OUT' | 'NEUTRAL'): string {
  if (direction === 'IN') return 'text-success-text';
  if (direction === 'OUT') return 'text-danger-text';
  return 'text-content';
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/** Debounce for search inputs, so a fast typist does not issue a query per key. */
export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}
