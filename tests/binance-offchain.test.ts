// Must precede the provider import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  BinanceProvider,
  depositToTransfer,
  offChainId,
  type DepositRecord,
} from '../src/modules/usdt/providers/binance.ts';

/**
 * USDT another Binance user paid to one of the account's deposit addresses.
 * Binance moves it inside itself — "Off-chain transfer 433778693577" where a
 * hash would be — so no chain shows it, and only the account's deposit
 * history does. Pinned: those are taken, a deposit that went over a chain is
 * not (the address's own watch reads it, and both would pay it twice), a
 * failed one is not, and a pending one waits.
 */

const OFFICE = '123456789';
const offChain = (over: Partial<DepositRecord> = {}): DepositRecord => ({
  amount: '38',
  coin: 'USDT',
  network: 'BSC',
  status: 1,
  address: '0x6263d5fa48bd9f1f85d027b3322d7920eb7a28fe',
  txId: 'Off-chain transfer 433778693577',
  insertTime: Date.parse('2026-11-22T10:16:41Z'),
  ...over,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('an off-chain Binance deposit', () => {
  it('reads the number Binance gives it in place of a hash', () => {
    assert.equal(offChainId('Off-chain transfer 433778693577'), '433778693577');
    assert.equal(offChainId('Off-chain Transfer433778693577'), '433778693577');
    assert.equal(offChainId('0xabc'), null);
    assert.equal(offChainId(null), null);
  });

  it('is money in on the office account, settled', () => {
    const transfer = depositToTransfer(offChain(), OFFICE);
    assert.ok(transfer);
    assert.equal(transfer.txHash, 'Off-chain transfer 433778693577');
    assert.equal(transfer.toAddress, OFFICE);
    assert.equal(transfer.amount, 38n * 100_000_000n);
    assert.equal(transfer.status, 'CONFIRMED');
    assert.match(transfer.memo ?? '', /BSC/);
  });

  it('takes every coin, as the coin it is', () => {
    const bnb = depositToTransfer(offChain({ coin: 'BNB', amount: '0.25' }), OFFICE);
    assert.equal(bnb?.tokenSymbol, 'BNB');
    assert.equal(bnb?.amount, 25_000_000n);
    assert.equal(depositToTransfer(offChain({ coin: 'USDC' }), OFFICE)?.tokenSymbol, 'USDC');
  });

  it('takes a deposit over a chain by its hash, unless a chain wallet reads that address', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    const onChain = offChain({ txId: hash, coin: 'TRX', network: 'TRX', address: 'TAbc' });
    assert.equal(depositToTransfer(onChain, OFFICE)?.txHash, hash);
    assert.match(depositToTransfer(onChain, OFFICE)?.memo ?? '', /Binance deposit/);
    // The office's TRON wallet reads USDT on that address: TRX there is still this account's to read.
    assert.ok(depositToTransfer(onChain, OFFICE, [{ network: 'TRON', address: 'tabc', token: 'USDT' }]));
    // USDT there is that wallet's.
    const usdt = offChain({ txId: hash, coin: 'USDT', network: 'TRX', address: 'TAbc' });
    assert.equal(depositToTransfer(usdt, OFFICE, [{ network: 'TRON', address: 'tabc', token: 'USDT' }]), null);
    // The same 0x address read on BNB Chain does not cover Ethereum.
    const eth = offChain({ txId: hash, network: 'ETH' });
    assert.ok(depositToTransfer(eth, OFFICE, [{ network: 'BSC', address: eth.address!, token: 'USDT' }]));
  });

  it('leaves out what failed, and a deposit with no hash at all', () => {
    assert.equal(depositToTransfer(offChain({ status: 7 }), OFFICE), null);
    assert.equal(depositToTransfer(offChain({ txId: '' }), OFFICE), null);
  });

  it('waits while Binance has it pending', () => {
    const transfer = depositToTransfer(offChain({ status: 0 }), OFFICE);
    assert.equal(transfer?.status, 'PENDING');
    assert.equal(transfer?.confirmations, 0);
  });

  it('is found by its number in the deposit history', async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify([offChain({ txId: 'Off-chain transfer 111111111' }), offChain()]));
    }) as typeof fetch;
    const provider = new BinanceProvider({ apiKey: 'key', apiSecret: 'secret' });
    const found = await provider.fetchOffChain('433778693577', OFFICE);
    assert.equal(found?.txHash, 'Off-chain transfer 433778693577');
    assert.ok(asked[0]?.includes('/sapi/v1/capital/deposit/hisrec'));
    assert.ok(asked[0]?.includes('signature='));
  });
});
