// Must precede the provider import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BscProvider } from '../src/modules/usdt/providers/bsc.ts';
import { TronProvider, tronAddress } from '../src/modules/usdt/providers/tron.ts';

/**
 * A transfer named by its hash — the one a customer reads out — found on the
 * chain at once: only the token's transfers that touch the counter's address,
 * nothing when the chain does not know the hash.
 */

const ME = '0x69671b28f8986ce3a259a10eb990132a963e6b17';
const SENDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3';
const OTHER = '0x1111111111111111111111111111111111111111';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;
const HASH = `0x${'ab'.repeat(32)}`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function node(receipt: unknown) {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { method, id } = JSON.parse(init.body);
    const result =
      method === 'eth_getTransactionReceipt'
        ? receipt
        : method === 'eth_blockNumber'
          ? `0x${(1_000_020).toString(16)}`
          : method === 'eth_getBlockByNumber'
            ? { timestamp: '0x6a1b5f2e' }
            : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }) as typeof fetch;
}

const log = (from: string, to: string, coins: bigint, address = USDT) => ({
  address,
  topics: [TRANSFER, pad(from), pad(to)],
  data: `0x${(coins * 10n ** 18n).toString(16)}`,
  blockNumber: `0x${(1_000_000).toString(16)}`,
  transactionHash: HASH,
  logIndex: '0x0',
});

describe('a BEP-20 transfer found by its hash', () => {
  it('keeps the USDT that reached our address, and its confirmations', async () => {
    node({
      status: '0x1',
      blockNumber: `0x${(1_000_000).toString(16)}`,
      logs: [log(SENDER, ME, 250n), log(SENDER, OTHER, 9n), log(SENDER, ME, 7n, OTHER)],
    });
    const found = await new BscProvider().fetchTransaction(HASH, ME, null);
    assert.equal(found?.length, 1);
    assert.equal(found?.[0]?.amount, 25_000_000_000n);
    assert.equal(found?.[0]?.fromAddress, SENDER);
    assert.equal(found?.[0]?.confirmations, 20);
    assert.equal(found?.[0]?.status, 'CONFIRMED');
  });

  it('says the chain does not know a hash, apart from one that paid someone else', async () => {
    node(null);
    assert.equal(await new BscProvider().fetchTransaction(HASH, ME, null), null);
    node({ status: '0x1', blockNumber: '0x10', logs: [log(SENDER, OTHER, 5n)] });
    assert.deepEqual(await new BscProvider().fetchTransaction(HASH, ME, null), []);
  });

  it('marks a reverted transaction failed', async () => {
    node({ status: '0x0', blockNumber: `0x${(1_000_000).toString(16)}`, logs: [log(SENDER, ME, 1n)] });
    const found = await new BscProvider().fetchTransaction(HASH, ME, null);
    assert.equal(found?.[0]?.status, 'FAILED');
  });
});

describe('a pasted hash', () => {
  it('is looked for on TRON and on BNB Chain when it comes without 0x', async () => {
    const { hashFamilies } = await import('../src/modules/usdt/sync.service.ts');
    const bare = 'AB'.repeat(32);
    assert.deepEqual(hashFamilies(bare), [
      { hash: 'ab'.repeat(32), networks: ['TRON'] },
      { hash: `0x${'ab'.repeat(32)}`, networks: ['BSC', 'ETHEREUM'] },
    ]);
    assert.deepEqual(hashFamilies(`0x${'cd'.repeat(32)}`), [{ hash: `0x${'cd'.repeat(32)}`, networks: ['BSC', 'ETHEREUM'] }]);
    assert.equal(hashFamilies(`https://bscscan.com/tx/0x${'ef'.repeat(32)}`)[0]?.hash, `0x${'ef'.repeat(32)}`);
    assert.deepEqual(hashFamilies('12345'), []);
  });
});

describe('a TRC-20 transfer found by its hash', () => {
  it('writes an event address the way TRON does', () => {
    assert.equal(tronAddress('0xa614f803b6fd780986a42c78ec9c7f77e6ded13c'), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    assert.equal(tronAddress('nonsense'), null);
  });

  it('keeps the USDT event that reached our address', async () => {
    const me = tronAddress('0x42097c50a4d6d1b6b4673d027a6f6297e401f8ea')!;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              block_number: 88220818,
              block_timestamp: Date.now() - 60_000,
              contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
              event_name: 'Transfer',
              result: {
                from: '0x8ffdd64e2d1252ad1da8b8d212e4119f31feb200',
                to: '0x42097c50a4d6d1b6b4673d027a6f6297e401f8ea',
                value: '4386000000',
              },
            },
          ],
        }),
      )) as typeof fetch;
    const found = await new TronProvider({ baseUrl: 'https://tron.test', apiKey: '' }).fetchTransaction('ab'.repeat(32), me, null);
    assert.equal(found?.length, 1);
    assert.equal(found?.[0]?.toAddress, me);
    assert.equal(found?.[0]?.amount, 438_600_000_000n);
    assert.ok((found?.[0]?.confirmations ?? 0) >= 19);
  });

  it('says the chain does not know a hash with no events', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ success: true, data: [] }))) as typeof fetch;
    assert.equal(await new TronProvider({ baseUrl: 'https://tron.test', apiKey: '' }).fetchTransaction('ab'.repeat(32), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', null), null);
  });
});
