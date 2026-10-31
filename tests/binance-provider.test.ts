// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import {
  BinanceProvider,
  payToTransfer,
  type PayRecord,
} from '../src/modules/usdt/providers/binance.ts';

/**
 * The office's Binance account, read through Binance Pay history. Pinned: money
 * in is IN and money out is OUT, only the watched token counts, every request
 * is signed with the secret, and a heavy history is read in windows that are
 * split when full — never trusted past Binance's page of a hundred.
 */

const UNIT = 100_000_000n;
const OFFICE = '123456789';

const record = (over: Partial<PayRecord> = {}): PayRecord => ({
  orderType: 'C2C',
  transactionId: 'M_P_1',
  transactionTime: Date.parse('2026-10-31T09:00:00Z'),
  amount: '150.5',
  currency: 'USDT',
  payerInfo: { name: 'Fadi Abu Hajar' },
  receiverInfo: { binanceId: OFFICE },
  ...over,
});

describe('a Binance Pay record', () => {
  it('is money in, from the payer by name, when the amount is positive', () => {
    const transfer = payToTransfer(record(), OFFICE, 'USDT')!;
    assert.equal(transfer.toAddress, OFFICE);
    assert.equal(transfer.fromAddress, 'Fadi Abu Hajar');
    assert.equal(transfer.amount, 15_050_000_000n);
    assert.equal(transfer.status, 'CONFIRMED');
    assert.equal(transfer.txHash, 'M_P_1');
    assert.match(transfer.memo ?? '', /Fadi Abu Hajar/);
  });

  it('is money out, to the receiver, when the amount is negative', () => {
    const transfer = payToTransfer(
      record({
        amount: '-20',
        payerInfo: { binanceId: OFFICE },
        receiverInfo: { binanceId: '555666777', name: 'Sami' },
      }),
      OFFICE,
      'USDT',
    )!;
    assert.equal(transfer.fromAddress, OFFICE);
    assert.equal(transfer.toAddress, '555666777');
    assert.equal(transfer.amount, 20n * UNIT);
  });

  it('ignores any other coin, and an empty amount', () => {
    assert.equal(payToTransfer(record({ currency: 'BNB' }), OFFICE, 'USDT'), null);
    assert.equal(payToTransfer(record({ amount: '0' }), OFFICE, 'USDT'), null);
  });
});

describe('the Binance provider', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** A stand-in for Binance that checks every signature and records each call. */
  function fakeBinance(answer: (path: string, params: URLSearchParams) => unknown, secret: string) {
    const calls: { path: string; params: URLSearchParams; key: string | null }[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const params = new URLSearchParams(url.search);
      const signature = params.get('signature');
      params.delete('signature');
      const expected = createHmac('sha256', secret).update(params.toString()).digest('hex');
      assert.equal(signature, expected, 'request must be signed with the secret');
      const key = new Headers(init?.headers).get('X-MBX-APIKEY');
      calls.push({ path: url.pathname, params, key });
      return new Response(JSON.stringify(answer(url.pathname, params)), { status: 200 });
    }) as typeof fetch;
    return calls;
  }

  it('accepts a Binance ID and nothing else as the address', () => {
    const provider = new BinanceProvider();
    assert.ok(provider.validateAddress('123456789'));
    assert.ok(!provider.validateAddress('TQ5…'));
    assert.ok(!provider.validateAddress('12345'));
  });

  it('adds the funding and spot balances, signed with the key', async () => {
    const calls = fakeBinance(
      (path) =>
        path.includes('funding')
          ? [{ asset: 'USDT', free: '100.5', locked: '0', freeze: '0' }]
          : [{ asset: 'USDT', free: '20', locked: '1.5', freeze: '0' }],
      'secret-1',
    );
    const balance = await new BinanceProvider({
      apiKey: 'key-1',
      apiSecret: 'secret-1',
    }).fetchBalance('');
    assert.equal(balance, 122n * UNIT);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.key === 'key-1'));
  });

  it('reads Pay history from the cursor and returns only the office’s USDT', async () => {
    const now = Date.now();
    const calls = fakeBinance(
      () => ({
        code: '000000',
        success: true,
        data: [
          record({ transactionId: 'A', transactionTime: now - 60_000 }),
          record({ transactionId: 'B', currency: 'BTC' }),
        ],
      }),
      'secret-2',
    );
    const page = await new BinanceProvider({
      apiKey: 'key-2',
      apiSecret: 'secret-2',
    }).fetchTransfers(OFFICE, null, { cursor: String(now - 5 * 60_000) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.path, '/sapi/v1/pay/transactions');
    // Ten minutes re-read behind the cursor.
    assert.ok(Number(calls[0]!.params.get('startTime')) <= now - 15 * 60_000 + 1000);
    assert.deepEqual(
      page.transfers.map((transfer) => transfer.txHash),
      ['A'],
    );
    assert.equal(page.hasMore, false);
  });

  it('does not ask again within fifteen seconds', async () => {
    const calls = fakeBinance(() => ({ code: '000000', success: true, data: [] }), 'secret-3');
    const provider = new BinanceProvider({ apiKey: 'key-3', apiSecret: 'secret-3' });
    await provider.fetchTransfers(OFFICE, null, { cursor: String(Date.now()) });
    const again = await provider.fetchTransfers(OFFICE, null, { cursor: '42' });
    assert.equal(calls.length, 1);
    assert.equal(again.cursor, '42');
  });

  it('splits a window that came back full instead of trusting it', async () => {
    let n = 0;
    const calls = fakeBinance(() => {
      n += 1;
      const size = n === 1 ? 100 : 3;
      return {
        code: '000000',
        success: true,
        data: Array.from({ length: size }, (_, i) => record({ transactionId: `T${n}-${i}` })),
      };
    }, 'secret-4');
    const page = await new BinanceProvider({
      apiKey: 'key-4',
      apiSecret: 'secret-4',
    }).fetchTransfers(OFFICE, null, { cursor: String(Date.now() - 60 * 60_000) });
    // Full, then its first half, then the half after it — nothing skipped.
    assert.equal(calls.length, 3);
    const [first, second, third] = calls.map((call) => call.params);
    assert.equal(second!.get('startTime'), first!.get('startTime'));
    assert.ok(Number(second!.get('endTime')) < Number(first!.get('endTime')));
    assert.equal(Number(third!.get('startTime')), Number(second!.get('endTime')) + 1);
    // The full answer is not kept; the two halves are.
    assert.equal(page.transfers.length, 6);
    assert.equal(page.hasMore, false);
  });

  it('says plainly when Binance refuses the server’s location or the key', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ code: 0, msg: 'Service unavailable from a restricted location' }),
        {
          status: 451,
        },
      )) as typeof fetch;
    await assert.rejects(
      new BinanceProvider({ apiKey: 'k5', apiSecret: 's5' }).fetchBalance(''),
      /outside the United States/,
    );

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' }),
        {
          status: 401,
        },
      )) as typeof fetch;
    await assert.rejects(
      new BinanceProvider({ apiKey: 'k6', apiSecret: 's6' }).fetchBalance(''),
      /rejected the API key/,
    );
  });

  it('refuses to read a wallet with no key', async () => {
    await assert.rejects(new BinanceProvider().fetchBalance(''), /no API key/);
  });
});
