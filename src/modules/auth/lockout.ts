/**
 * Where an account stands against the lockout after failed sign-ins.
 *
 * Five wrong passwords lock an account for a while: its status turns LOCKED
 * and lockedUntil says until when. Once that time has passed the lock is over
 * — the account opens again by itself at its next sign-in, rather than staying
 * LOCKED for good until someone reactivates it. A status the manager set by
 * hand (suspended, disabled) is never LOCKED, so is never lifted here.
 *
 * Pure, so the rule can be read and tested on its own.
 */
export type LockState = 'locked' | 'expired' | 'open';

export function lockState(
  user: { status: string; lockedUntil: Date | null },
  now: Date,
): LockState {
  if (user.lockedUntil && user.lockedUntil > now) return 'locked';
  if (user.status === 'LOCKED' && user.lockedUntil && user.lockedUntil <= now) return 'expired';
  return 'open';
}
