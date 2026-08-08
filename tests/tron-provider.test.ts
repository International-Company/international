// Must precede the provider import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { TronProvider } from '../src/modules/usdt/providers/tron.ts';

/**
 * The credential state machine.
 *
 * A key TronGrid does not recognise is worse than no key at all: the public
 * tier answers an anonymous request, while an unknown key earns a flat 401. So
 * a desk whose key is revoked, expired, or mistyped into a deployment variable
 * would lose USDT monitoring outright — the one tool the counter cannot do its
 * job without — at the moment nobody is looking.
 *
 * These tests hold the fallback in place, and hold it honest: falling back must
 * never look like success, because a manager who cannot tell the difference
 * will not fix the key.
 */

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

/** Records every request so the presence of the auth header can be asserted. */
function stubFetch(handler: (url: string, key: string | null) => { status: number; body?: unknown }) {
  const calls: { url: string; key: string | null }[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const key = headers.get('TRON-PRO-API-KEY');
    calls.push({ url, key });

    const { status, body } = handler(url, key);
    return new Response(JSON.stringify(body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  return calls;
}

const BLOCK = { block_header: { raw_data: { number: 70_000_000 } } };

describe('TronProvider credentials', () => {
  it('reports ANONYMOUS when no key is configured', () => {
    assert.equal(new TronProvider({ apiKey: '' }).credentials(), 'ANONYMOUS');
  });

  it('reports KEYED before anything has been refused', () => {
    assert.equal(new TronProvider({ apiKey: 'a-key' }).credentials(), 'KEYED');
  });

  it('sends the key on an authenticated request', async () => {
    const calls = stubFetch(() => ({ status: 200, body: BLOCK }));
    const provider = new TronProvider({ apiKey: 'a-key' });

    await provider.currentBlock();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.key, 'a-key');
  });
});

describe('TronProvider fallback when a key is refused', () => {
  it('retries without the key and still returns data', async () => {
    // 401 whenever the key is presented; the public tier answers otherwise.
    const calls = stubFetch((_url, key) =>
      key ? { status: 401, body: { Error: 'ApiKey not exists' } } : { status: 200, body: BLOCK },
    );
    const provider = new TronProvider({ apiKey: 'wrong-key' });

    const block = await provider.currentBlock();

    assert.equal(block, 70_000_000n, 'the call must survive a refused key');
    assert.equal(calls.length, 2, 'exactly one retry, not a loop');
    assert.equal(calls[0]?.key, 'wrong-key');
    assert.equal(calls[1]?.key, null, 'the retry must be anonymous');
  });

  it('admits the key was refused rather than reporting success', async () => {
    const provider = new TronProvider({ apiKey: 'wrong-key' });
    stubFetch((_url, key) => (key ? { status: 401 } : { status: 200, body: BLOCK }));

    assert.equal(provider.credentials(), 'KEYED');
    await provider.currentBlock();
    assert.equal(provider.credentials(), 'REJECTED');
  });

  it('stops presenting a key it already knows is dead', async () => {
    const calls = stubFetch((_url, key) => (key ? { status: 401 } : { status: 200, body: BLOCK }));
    const provider = new TronProvider({ apiKey: 'wrong-key' });

    await provider.currentBlock();
    await provider.currentBlock();
    await provider.currentBlock();

    // One rejected attempt, then never again — three calls, not six.
    assert.equal(calls.filter((call) => call.key !== null).length, 1);
    assert.equal(calls.length, 4);
  });

  it('does not swallow a 401 that arrives with no key configured', async () => {
    // Nothing to fall back to, so this must surface rather than retry silently.
    const calls = stubFetch(() => ({ status: 401 }));
    const provider = new TronProvider({ apiKey: '' });

    // currentBlock() is deliberately forgiving; fetchBalance is not.
    await assert.rejects(() => provider.fetchBalance('TNaRAoLUyYEV2uF7GUrzSjRQTU8v5ZJ5VR'));
    assert.equal(calls.length, 1, 'no retry is possible without a key');
    assert.equal(provider.credentials(), 'ANONYMOUS');
  });

  it('leaves other failures alone', async () => {
    const calls = stubFetch(() => ({ status: 500 }));
    const provider = new TronProvider({ apiKey: 'a-key' });

    await assert.rejects(() => provider.fetchBalance('TNaRAoLUyYEV2uF7GUrzSjRQTU8v5ZJ5VR'));
    assert.equal(calls.length, 1, 'a server error is not a credential problem');
    assert.equal(provider.credentials(), 'KEYED', 'the key must not be blamed for a 500');
  });
});
