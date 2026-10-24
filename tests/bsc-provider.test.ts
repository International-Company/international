// Must precede the provider import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BscProvider } from '../src/modules/usdt/providers/bsc.ts';

/**
 * Reading BEP-20 USDT straight from a node.
 *
 * The decoding is the part worth pinning: the sender lives in a topic, the
 * amount in the data at 18 decimals, and the cursor has to move forward
 * without ever asking the node for more history than it keeps.
 */

const ME = '0x69671b28f8986ce3a259a10eb990132a963e6b17';
const SENDER = '0x8894e0a0c962cb723c1976a4421c95949be2d4e3';
const pad = (address: string) => `0x${address.slice(2).padStart(64, '0')}`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function node(head: number, logs: unknown[]) {
  const asked: { method: string; params: unknown[] }[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const { method, params, id } = JSON.parse(init.body);
    asked.push({ method, params });
    const result =
      method === 'eth_blockNumber'
        ? `0x${head.toString(16)}`
        : method === 'eth_getLogs'
          ? logs
          : method === 'eth_getBlockByNumber'
            ? { timestamp: '0x6a1b5f2e' }
            : null;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }) as typeof fetch;
  return asked;
}

describe('the BNB Smart Chain provider', () => {
  it('reads the sender from the topic and the amount at 18 decimals', async () => {
    node(1_000_000, [
      {
        address: '0x55d398326f99059ff775485246999027b3197955',
        topics: ['0xddf2', pad(SENDER), pad(ME)],
        // 24.99000001 USDT, 18 decimals
        data: `0x${(24_990_000_010_000_000_000n).toString(16)}`,
        blockNumber: `0x${(999_000).toString(16)}`,
        transactionHash: '0xabc',
        logIndex: '0x0',
      },
    ]);

    const page = await new BscProvider({ range: 3000, reach: 9000 }).fetchTransfers(ME, null);
    const [transfer] = page.transfers;

    assert.equal(transfer?.fromAddress, SENDER);
    assert.equal(transfer?.toAddress, ME);
    assert.equal(transfer?.amount, 2_499_000_001n);
    assert.equal(transfer?.confirmations, 1000);
    assert.equal(page.cursor, '1000001');
    assert.equal(page.hasMore, false);
  });

  it('asks only for transfers to this address, in ranges the node accepts', async () => {
    const asked = node(1_000_000, []);
    await new BscProvider({ range: 3000, reach: 9000 }).fetchTransfers(ME, null, {
      cursor: '995000',
    });

    const ranges = asked.filter((call) => call.method === 'eth_getLogs');
    for (const call of ranges) {
      const filter = call.params[0] as { fromBlock: string; toBlock: string; topics: unknown[] };
      assert.deepEqual(filter.topics.slice(1), [null, pad(ME)]);
      assert.ok(Number(filter.toBlock) - Number(filter.fromBlock) < 3000);
    }
    // re-read a little behind the cursor, so a young transfer is seen again
    assert.equal(Number((ranges[0]!.params[0] as { fromBlock: string }).fromBlock), 995000 - 240);
  });

  it('never asks further back than the node keeps', async () => {
    const asked = node(1_000_000, []);
    await new BscProvider({ range: 3000, reach: 9000 }).fetchTransfers(ME, null, {
      cursor: '100',
    });
    const first = asked.find((call) => call.method === 'eth_getLogs')!;
    assert.equal(Number((first.params[0] as { fromBlock: string }).fromBlock), 1_000_000 - 9000);
  });
});
