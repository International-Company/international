import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { busyFor, report } from '../src/modules/whatsapp/inbox-presence.ts';

describe('who is in which customer conversation', () => {
  const t0 = 1_000_000;
  const ali = { id: 'ali', name: 'علي' };
  const sara = { id: 'sara', name: 'سارة' };

  it('shows the others in a conversation, never oneself', () => {
    report(ali, '970599000001', false, t0);
    report(sara, '970599000002', true, t0);
    assert.deepEqual(busyFor('ali', t0 + 1000), [{ phone: '970599000002', name: 'سارة', typing: true }]);
    assert.deepEqual(busyFor('sara', t0 + 1000), [{ phone: '970599000001', name: 'علي', typing: false }]);
  });

  it('moves with the person to the next conversation, and lets go when none is open', () => {
    report(ali, '970599000003', false, t0 + 2000);
    assert.deepEqual(busyFor('sara', t0 + 2000).map((entry) => entry.phone), ['970599000003']);
    report(ali, null, false, t0 + 3000);
    assert.deepEqual(busyFor('sara', t0 + 3000), []);
  });

  it('forgets someone whose screen stopped saying so', () => {
    report(sara, '970599000002', false, t0);
    assert.equal(busyFor('ali', t0 + 10_000).length, 1);
    assert.equal(busyFor('ali', t0 + 60_000).length, 0);
  });
});
