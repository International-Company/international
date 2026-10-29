// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  announceDeal,
  composeDeletion,
  kindLabel,
  titleOf,
  type AnnounceDeps,
  type AnnouncedDeal,
} from '../src/modules/whatsapp/announce.ts';

/**
 * What the WhatsApp group reads when a deal is deleted. Pinned: buying and
 * selling said plainly, with the reason and who deleted it. The deal itself
 * is written by the share message, pinned in its own tests.
 */

const UNIT = 100_000_000n;

const deal = (over: Partial<AnnouncedDeal> = {}): AnnouncedDeal => ({
  reference: 'TXN-20261029-00001',
  type: 'EXCHANGE',
  status: 'POSTED',
  fromCurrency: 'USD',
  fromAmount: 100n * UNIT,
  toCurrency: 'ILS',
  toAmount: 365n * UNIT,
  payoutBankAmount: 0n,
  payoutBankChannel: null,
  payoutAccount: null,
  intakeBrokerAmount: 0n,
  intakeBankChannel: null,
  counterpartyName: null,
  counterpartyPhone: null,
  notes: null,
  createdAt: new Date('2026-10-29T10:05:00Z'),
  customer: null,
  createdBy: { fullNameAr: 'أحمد' },
  ...over,
});

describe('the WhatsApp announcement', () => {
  it('says buying and selling from the office’s side', () => {
    assert.equal(titleOf(deal()), 'شراء USD');
    assert.equal(titleOf(deal({ fromCurrency: 'ILS', toCurrency: 'USD' })), 'بيع USD');
    assert.equal(titleOf(deal({ type: 'USDT_SALE' })), 'بيع USDT');
  });

  it('announces a deletion with its reason', () => {
    const text = composeDeletion(deal(), 'سامي', 'خطأ في المبلغ');
    assert.match(text, /حذف عملية — شراء USD/);
    assert.match(text, /السبب: خطأ في المبلغ/);
    assert.match(text, /حذفها: سامي/);
  });
});

/**
 * The deal, then its kind as a reply. A stand-in for WhatsApp records each
 * message the bot would send, and what it was replying to.
 */
describe('announcing a deal to the group', () => {
  const GROUP = '120363000000000000@g.us';
  const TEXT = '0597085125\n\nفادي ابو حجر\n\nبال باي\n\n290 شيكل';

  function harness(over: Partial<AnnounceDeps> & { type?: string; failOn?: number } = {}) {
    const sent: { jid: string; text: string; quotedId: string | null }[] = [];
    let n = 0;
    const deps: AnnounceDeps = {
      target: async () => GROUP,
      load: async () => ({
        reference: 'TXN-1',
        type: over.type ?? 'EXCHANGE',
        companyName: '',
        text: TEXT,
        phone: null,
      }),
      send: async (jid, text, quoted) => {
        n += 1;
        if (over.failOn === n) throw new Error('socket closed');
        sent.push({ jid, text, quotedId: quoted?.key?.id ?? null });
        return { key: { id: `MSG${n}`, remoteJid: jid, fromMe: true } } as never;
      },
      pause: 1,
      ...over,
    };
    return { deps, sent };
  }

  it('sends the deal, then replies to it with «صرافة»', async () => {
    const { deps, sent } = harness();
    assert.equal(await announceDeal('t1', deps), 'SENT');
    assert.deepEqual(sent, [
      { jid: GROUP, text: TEXT, quotedId: null },
      { jid: GROUP, text: 'صرافة', quotedId: 'MSG1' },
    ]);
  });

  it('labels a USDT receipt «استلام يواس»', async () => {
    const { deps, sent } = harness({ type: 'USDT_RECEIVE' });
    assert.equal(await announceDeal('t1', deps), 'SENT');
    assert.equal(sent[1]?.text, 'استلام يواس');
    assert.equal(sent[1]?.quotedId, 'MSG1');
  });

  it('names every kind of deal the counter records', () => {
    assert.equal(kindLabel('EXCHANGE'), 'صرافة');
    assert.equal(kindLabel('WALLET_CASHOUT'), 'صرافة');
    assert.equal(kindLabel('USDT_RECEIVE'), 'استلام يواس');
    assert.equal(kindLabel('USDT_SEND'), 'سحب يواس');
    assert.equal(kindLabel('USDT_SALE'), 'بيع يواس');
    assert.equal(kindLabel('REMITTANCE_OUT'), 'حوالة صادرة');
  });

  it('sends no reply when the deal itself did not go out', async () => {
    const { deps, sent } = harness({ failOn: 1 });
    assert.equal(await announceDeal('t1', deps), 'SEND_FAILED');
    assert.equal(sent.length, 0);
  });

  it('does not throw when the reply fails — the deal is already in the group', async () => {
    const { deps, sent } = harness({ failOn: 2 });
    assert.equal(await announceDeal('t1', deps), 'NO_REPLY');
    assert.equal(sent.length, 1);
  });

  it('replies to nothing when WhatsApp gives no message back', async () => {
    const { deps, sent } = harness({
      send: async (jid, text) => {
        sent.push({ jid, text, quotedId: null });
        return undefined;
      },
    });
    assert.equal(await announceDeal('t1', deps), 'NO_REPLY');
    assert.equal(sent.length, 1);
  });

  it('waits for a deal still being committed, then sends it', async () => {
    let reads = 0;
    const { deps, sent } = harness({
      load: async () => {
        reads += 1;
        if (reads < 3) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
        return { reference: 'TXN-1', type: 'EXCHANGE', companyName: '', text: TEXT, phone: null };
      },
    });
    assert.equal(await announceDeal('t1', deps), 'SENT');
    assert.equal(reads, 3);
    assert.equal(sent.length, 2);
  });

  it('gives up on a deal that never appears, and sends nothing', async () => {
    const { deps, sent } = harness({
      load: async () => {
        throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
      },
    });
    assert.equal(await announceDeal('t1', deps), 'NOT_FOUND');
    assert.equal(sent.length, 0);
  });

  it('sends nothing when the office has not switched it on', async () => {
    const { deps, sent } = harness({ target: async () => null });
    assert.equal(await announceDeal('t1', deps), 'SKIPPED');
    assert.equal(sent.length, 0);
  });
});
