import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { lockState } from '../src/modules/auth/lockout.ts';

const now = new Date('2026-11-19T10:00:00Z');
const minutes = (count: number) => new Date(now.getTime() + count * 60_000);

describe('the lockout after failed sign-ins', () => {
  it('holds while the lock lasts', () => {
    assert.equal(lockState({ status: 'LOCKED', lockedUntil: minutes(5) }, now), 'locked');
  });

  it('is over once its time has passed, so the account opens again by itself', () => {
    assert.equal(lockState({ status: 'LOCKED', lockedUntil: minutes(-1) }, now), 'expired');
    assert.equal(lockState({ status: 'LOCKED', lockedUntil: now }, now), 'expired');
  });

  it('never lifts what the manager set by hand', () => {
    assert.equal(lockState({ status: 'SUSPENDED', lockedUntil: minutes(-30) }, now), 'open');
    assert.equal(lockState({ status: 'DISABLED', lockedUntil: null }, now), 'open');
    // Locked with no end given is not a lockout this rule knows: left as it is.
    assert.equal(lockState({ status: 'LOCKED', lockedUntil: null }, now), 'open');
  });

  it('leaves an active account alone', () => {
    assert.equal(lockState({ status: 'ACTIVE', lockedUntil: null }, now), 'open');
  });
});
