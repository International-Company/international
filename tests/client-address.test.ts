import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Which entry of `X-Forwarded-For` is the caller.
 *
 * The header is written by the caller and appended to by every proxy it passes
 * through, so the chain reads `client, proxy1, proxy2` and the left-most entry
 * *looks* like the client. It is not: it is whatever arrived, and what arrived
 * came from the caller. Reading it put an attacker-chosen value into the audit
 * log's actor address and let anyone escape an address-keyed rate limit by
 * changing one header per request.
 *
 * The right-most entry is the one our own proxy wrote about the hop it spoke
 * to, and is the only entry no caller can forge.
 *
 * The rule is pinned here rather than only in `getRequestMeta`, because that
 * function reaches for Next's request headers and cannot be called outside a
 * request — and this is exactly the kind of line somebody simplifies back to
 * `split(',')[0]` while tidying.
 */
function clientAddress(forwardedFor: string | null, realIp: string | null): string | null {
  const chain =
    forwardedFor
      ?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return chain.at(-1) || realIp || null;
}

describe('the caller address behind one proxy', () => {
  it('takes the entry the proxy appended, not the one the caller sent', () => {
    // The caller claimed 10.0.0.1; our proxy appended what it really saw.
    assert.equal(clientAddress('10.0.0.1, 203.0.113.7', null), '203.0.113.7');
  });

  it('is the single entry when nobody forged anything', () => {
    assert.equal(clientAddress('203.0.113.7', null), '203.0.113.7');
  });

  it('cannot be steered by padding the chain', () => {
    assert.equal(
      clientAddress('1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.7', null),
      '203.0.113.7',
    );
  });

  it('ignores the blanks a hand-written header tends to carry', () => {
    assert.equal(clientAddress(' , 10.0.0.1 ,  , 203.0.113.7 , ', null), '203.0.113.7');
  });

  it('falls back to the socket header when no proxy wrote a chain', () => {
    assert.equal(clientAddress(null, '198.51.100.4'), '198.51.100.4');
    assert.equal(clientAddress('', '198.51.100.4'), '198.51.100.4');
  });

  it('admits it does not know rather than inventing one', () => {
    assert.equal(clientAddress(null, null), null);
    assert.equal(clientAddress('  ,  ', null), null);
  });
});
