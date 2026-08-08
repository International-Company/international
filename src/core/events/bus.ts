import 'server-only';
import { createLogger } from '@/core/logger/logger';

/**
 * In-process domain event bus.
 *
 * Modules publish facts about what happened; other modules subscribe without
 * the publisher knowing they exist. This is what keeps the monolith modular:
 * the exchange module never imports the notification module, it just announces
 * that a transaction was posted.
 *
 * Handlers run after the emitting transaction has committed and their failures
 * are isolated — a broken notification handler must never roll back a posted
 * financial transaction.
 */

const log = createLogger('events');

export interface DomainEvents {
  'transaction.created': { transactionId: string; reference: string; type: string; actorId: string };
  'transaction.submitted': { transactionId: string; reference: string; actorId: string };
  'transaction.posted': { transactionId: string; reference: string; type: string; actorId: string };
  'transaction.reversed': { transactionId: string; reversalId: string; actorId: string };

  'rate.changed': { baseCode: string; quoteCode: string; rateId: string; actorId: string };

  'wallet.created': { walletId: string; address: string; network: string; actorId: string };
  'wallet.synced': { walletId: string; created: number; updated: number };
  'chain.transaction.detected': {
    chainTransactionId: string;
    walletId: string;
    direction: string;
    amount: string;
    txHash: string;
  };
  'chain.transaction.confirmed': { chainTransactionId: string; walletId: string; direction: string };

  'day.opened': { businessDayId: string; branchId: string; actorId: string };
  'day.closed': { businessDayId: string; branchId: string; actorId: string; hasDifference: boolean };

  'drawer.balance.low': { currency: string; balance: string; threshold: string };

  'user.login': { userId: string; ip: string | null };
  'user.login.failed': { username: string; ip: string | null; reason: string };
  'user.locked': { userId: string; username: string };

  'backup.completed': { backupId: string; status: string };
}

export type EventName = keyof DomainEvents;
export type EventHandler<K extends EventName> = (payload: DomainEvents[K]) => void | Promise<void>;

interface Registration {
  name: string;
  handler: (payload: unknown) => void | Promise<void>;
}

/** Survives hot reload in development, which would otherwise duplicate handlers. */
const globalForBus = globalThis as unknown as { __ifmsEventBus?: Map<string, Registration[]> };
const handlers: Map<string, Registration[]> = globalForBus.__ifmsEventBus ?? new Map();
globalForBus.__ifmsEventBus = handlers;

export function on<K extends EventName>(
  event: K,
  name: string,
  handler: EventHandler<K>,
): () => void {
  const list = handlers.get(event) ?? [];

  // Re-registering the same named handler replaces it rather than stacking.
  const existing = list.findIndex((r) => r.name === name);
  const registration: Registration = { name, handler: handler as Registration['handler'] };
  if (existing >= 0) list[existing] = registration;
  else list.push(registration);

  handlers.set(event, list);

  return () => {
    const current = handlers.get(event) ?? [];
    handlers.set(event, current.filter((r) => r.name !== name));
  };
}

/**
 * Publishes an event. Each handler is isolated: one throwing does not prevent
 * the others from running, and never propagates to the publisher.
 */
export async function emit<K extends EventName>(event: K, payload: DomainEvents[K]): Promise<void> {
  const list = handlers.get(event) ?? [];
  if (list.length === 0) return;

  log.debug('emit', { event, handlers: list.length });

  const results = await Promise.allSettled(list.map((r) => Promise.resolve(r.handler(payload))));

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      log.error('Event handler failed', {
        event,
        handler: list[index]?.name,
        error: result.reason,
      });
    }
  });
}

/** Fire-and-forget for call sites that must not wait on subscribers. */
export function emitAsync<K extends EventName>(event: K, payload: DomainEvents[K]): void {
  void emit(event, payload);
}

export function registeredHandlers(): Record<string, string[]> {
  return Object.fromEntries([...handlers].map(([event, list]) => [event, list.map((r) => r.name)]));
}
