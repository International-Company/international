// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  announceDeal,
  composeCopyCancelled,
  copyNumberAndSum,
  announced,
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

  function harness(
    over: Partial<AnnounceDeps> & { type?: string; bankPayout?: boolean; failOn?: number } = {},
  ) {
    const sent: { jid: string; text: string; quotedId: string | null }[] = [];
    let n = 0;
    const deps: AnnounceDeps = {
      target: async () => GROUP,
      load: async () => ({
        reference: 'TXN-1',
        type: over.type ?? 'EXCHANGE',
        bankPayout: over.bankPayout ?? true,
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

  it('puts the proof of payment with the deal and the beneficiary’s details in a reply', async () => {
    const shots: { kind: string; caption: string; quotedId: string | null }[] = [];
    const { deps, sent } = harness({
      photos: async () => [
        { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'PAYMENT' },
        { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'BENEFICIARY' },
      ],
      sendPhoto: async (_jid, photo, caption, quoted) => {
        shots.push({ kind: photo.kind, caption, quotedId: quoted?.key?.id ?? null });
        return { key: { id: `shot-${shots.length}` } } as never;
      },
    });
    assert.equal(await announceDeal('t1', deps), 'SENT');
    assert.deepEqual(shots, [
      { kind: 'PAYMENT', caption: TEXT, quotedId: null },
      { kind: 'BENEFICIARY', caption: 'بيانات المستفيد', quotedId: 'shot-1' },
    ]);
    assert.equal(sent.length, 1, 'only the label goes as words');
  });

  it('still counts as sent when the second photo fails', async () => {
    const { deps } = harness({
      photos: async () => [
        { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'PAYMENT' },
        { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'BENEFICIARY' },
      ],
      sendPhoto: async (_jid, photo) => {
        if (photo.kind === 'BENEFICIARY') throw new Error('upload failed');
        return { key: { id: 'shot-1' } } as never;
      },
    });
    assert.equal(await announceDeal('t1', deps), 'SENT');
  });

  describe('a remittance sent', () => {
    const both = [
      { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'PAYMENT' },
      { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'BENEFICIARY' },
    ];
    const camera = (failOn?: string) => {
      const shots: { kind: string; caption: string; quotedId: string | null }[] = [];
      return {
        shots,
        sendPhoto: async (_jid: string, photo: { kind: string }, caption: string, quoted?: { key?: { id?: string | null } }) => {
          if (photo.kind === failOn) throw new Error('upload failed');
          shots.push({ kind: photo.kind, caption, quotedId: quoted?.key?.id ?? null });
          return { key: { id: `shot-${shots.length}` } } as never;
        },
      };
    };

    it('is the proof bare, then the beneficiary in reply carrying the words, and no label', async () => {
      const { shots, sendPhoto } = camera();
      const { deps, sent } = harness({ type: 'REMITTANCE_OUT', photos: async () => both, sendPhoto });
      assert.equal(await announceDeal('t1', deps), 'SENT');
      assert.deepEqual(shots, [
        { kind: 'PAYMENT', caption: '', quotedId: null },
        { kind: 'BENEFICIARY', caption: TEXT, quotedId: 'shot-1' },
      ]);
      assert.equal(sent.length, 0, 'no «حوالة صادرة»');
    });

    it('puts the words on the only photo there is', async () => {
      const { shots, sendPhoto } = camera();
      const { deps, sent } = harness({
        type: 'REMITTANCE_OUT',
        photos: async () => [both[1]!],
        sendPhoto,
      });
      assert.equal(await announceDeal('t1', deps), 'SENT');
      assert.equal(shots[0]?.caption, TEXT);
      assert.equal(sent.length, 0);
    });

    it('goes as words alone with no photo, and no label', async () => {
      const { deps, sent } = harness({ type: 'REMITTANCE_OUT' });
      assert.equal(await announceDeal('t1', deps), 'SENT');
      assert.deepEqual(sent, [{ jid: GROUP, text: TEXT, quotedId: null }]);
    });

    it('never loses the words when the photo carrying them fails', async () => {
      const { shots, sendPhoto } = camera('BENEFICIARY');
      const { deps, sent } = harness({ type: 'REMITTANCE_OUT', photos: async () => both, sendPhoto });
      assert.equal(await announceDeal('t1', deps), 'SENT');
      assert.equal(shots[0]?.caption, '');
      assert.deepEqual(sent, [{ jid: GROUP, text: TEXT, quotedId: 'shot-1' }]);
    });

    it('says them once when the first photo fails', async () => {
      const { shots, sendPhoto } = camera('PAYMENT');
      const { deps, sent } = harness({ type: 'REMITTANCE_OUT', photos: async () => both, sendPhoto });
      assert.equal(await announceDeal('t1', deps), 'SENT');
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.text, TEXT);
      assert.equal(shots[0]?.caption, 'بيانات المستفيد');
    });
  });

  describe('a USDT sale', () => {
    const photo = (kind: string) => ({ data: new Uint8Array(1), mimeType: 'image/jpeg', kind });
    const run = async (photos: ReturnType<typeof photo>[]) => {
      const shots: { kind: string; caption: string; quotedId: string | null }[] = [];
      const { deps, sent } = harness({
        type: 'USDT_SALE',
        photos: async () => photos,
        sendPhoto: async (_jid, each, caption, quoted) => {
          shots.push({ kind: each.kind, caption, quotedId: quoted?.key?.id ?? null });
          return { key: { id: `shot-${shots.length}` } } as never;
        },
      });
      assert.equal(await announceDeal('t1', deps), 'SENT');
      return { shots, sent };
    };

    it('is two messages: the transfer with its words, the address in reply', async () => {
      const { shots, sent } = await run([photo('PAYMENT'), photo('ADDRESS')]);
      assert.deepEqual(shots, [
        { kind: 'PAYMENT', caption: TEXT, quotedId: null },
        { kind: 'ADDRESS', caption: 'عنوان التحويل', quotedId: 'shot-1' },
      ]);
      assert.equal(sent.length, 0, 'no «بيع يواس»');
    });

    it('is one with a single photo, or with none', async () => {
      const one = await run([photo('ADDRESS')]);
      assert.equal(one.shots.length, 1);
      assert.equal(one.shots[0]?.caption, TEXT);
      assert.equal(one.sent.length, 0);
      const none = await run([]);
      assert.deepEqual(none.sent, [{ jid: GROUP, text: TEXT, quotedId: null }]);
    });
  });

  describe('a remittance paid in notes', () => {
    const NOTE = 'استلمت 100 شيكل نقدي';
    const payment = { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'PAYMENT' };
    const who = { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'BENEFICIARY' };
    const run = async (photos: (typeof who)[], failOn?: string) => {
      const out: { what: string; kind?: string; text: string; quotedId: string | null }[] = [];
      const { deps } = harness({
        type: 'REMITTANCE_OUT',
        load: async () => ({
          reference: 'TXN-1',
          type: 'REMITTANCE_OUT',
          bankPayout: false,
          companyName: '',
          text: TEXT,
          phone: null,
          cashNote: NOTE,
        }),
        send: async (_jid, text, quoted) => {
          out.push({ what: 'text', text, quotedId: quoted?.key?.id ?? null });
          return { key: { id: `m${out.length}` } } as never;
        },
        photos: async () => photos,
        sendPhoto: async (_jid, photo, caption, quoted) => {
          if (photo.kind === failOn) throw new Error('upload failed');
          out.push({
            what: 'photo',
            kind: photo.kind,
            text: caption,
            quotedId: quoted?.key?.id ?? null,
          });
          return { key: { id: `m${out.length}` } } as never;
        },
      });
      assert.equal(await announceDeal('t1', deps), 'SENT');
      return out;
    };

    it('opens by saying what was taken, then the beneficiary in reply with the words', async () => {
      assert.deepEqual(await run([who]), [
        { what: 'text', text: NOTE, quotedId: null },
        { what: 'photo', kind: 'BENEFICIARY', text: TEXT, quotedId: 'm1' },
      ]);
    });

    it('says it and then the words, with no photo at all', async () => {
      assert.deepEqual(await run([]), [
        { what: 'text', text: NOTE, quotedId: null },
        { what: 'text', text: TEXT, quotedId: 'm1' },
      ]);
    });

    it('says it on a photo of the payment if there is one', async () => {
      assert.deepEqual(await run([payment, who]), [
        { what: 'photo', kind: 'PAYMENT', text: NOTE, quotedId: null },
        { what: 'photo', kind: 'BENEFICIARY', text: TEXT, quotedId: 'm1' },
      ]);
      assert.deepEqual(await run([payment]), [
        { what: 'photo', kind: 'PAYMENT', text: NOTE, quotedId: null },
        { what: 'text', text: TEXT, quotedId: 'm1' },
      ]);
    });

    it('loses neither when a photo fails', async () => {
      assert.deepEqual(await run([who], 'BENEFICIARY'), [
        { what: 'text', text: NOTE, quotedId: null },
        { what: 'text', text: TEXT, quotedId: 'm1' },
      ]);
      assert.deepEqual(await run([payment, who], 'PAYMENT'), [
        { what: 'text', text: NOTE, quotedId: null },
        { what: 'photo', kind: 'BENEFICIARY', text: TEXT, quotedId: 'm1' },
      ]);
    });
  });

  describe('a remittance’s number and sum, to their own group', () => {
    const load = async () => ({
      reference: 'TXN-1',
      type: 'REMITTANCE_OUT',
      bankPayout: false,
      companyName: '',
      text: '+201008846989\n\n8130 جنيه',
      phone: null,
      copyText: '+201008846989\n\n8130 جنيه',
    });

    it('go as words alone', async () => {
      const sent: [string, string][] = [];
      await copyNumberAndSum('t1', {
        target: async () => 'exec@g.us',
        load,
        send: async (jid, text) => {
          sent.push([jid, text]);
          return {} as never;
        },
        pause: 1,
      });
      assert.deepEqual(sent, [['exec@g.us', '+201008846989\n\n8130 جنيه']]);
    });

    it('go nowhere without a group, and a failure stays quiet', async () => {
      let sends = 0;
      const send = async () => {
        sends += 1;
        throw new Error('socket closed');
      };
      await copyNumberAndSum('t1', { target: async () => null, load, send, pause: 1 });
      assert.equal(sends, 0);
      await copyNumberAndSum('t1', { target: async () => 'exec@g.us', load, send, pause: 1 });
      assert.equal(sends, 1);
    });

    const deal = {
      counterpartyPhone: '+201008846989',
      customer: null,
      deliveredAmount: 8130n * 100_000_000n,
      deliveredUnit: 'جنيه',
    };

    it('for a sale are its coins and address, on the address photo when there is one', async () => {
      const sale = async () => ({
        reference: 'TXN-2',
        type: 'USDT_SALE',
        bankPayout: false,
        companyName: '',
        text: 'everything',
        phone: null,
        copyText: '500 USDT\n\nTXabc',
      });
      const out: string[] = [];
      const deps = {
        target: async () => 'deposit@g.us',
        load: sale,
        send: async (_jid: string, text: string) => {
          out.push(`text:${text}`);
          return {} as never;
        },
        sendPhoto: async (_jid: string, photo: { kind: string }, caption: string) => {
          out.push(`photo:${photo.kind}:${caption}`);
          return {} as never;
        },
        pause: 1,
      };
      const address = { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'ADDRESS' };
      const payment = { data: new Uint8Array(1), mimeType: 'image/jpeg', kind: 'PAYMENT' };
      await copyNumberAndSum('t1', { ...deps, photos: async () => [payment, address] });
      await copyNumberAndSum('t1', { ...deps, photos: async () => [payment] });
      assert.deepEqual(out, ['photo:ADDRESS:500 USDT\n\nTXabc', 'text:500 USDT\n\nTXabc']);
    });

    it('send nothing for a deal with no part for that group', async () => {
      let sends = 0;
      await copyNumberAndSum('t1', {
        target: async () => 'any@g.us',
        load: async () => ({ ...(await load()), type: 'EXCHANGE', copyText: null }),
        send: async () => {
          sends += 1;
          return {} as never;
        },
        pause: 1,
      });
      assert.equal(sends, 0);
    });

    it('cancel a sale by its coins and address', () => {
      assert.equal(
        composeCopyCancelled({
          ...deal,
          type: 'USDT_SALE',
          toAmount: 500n * 100_000_000n,
          payoutAddress: 'TXabc',
        }),
        '🔴 *إيداع ملغى*\n\n500 USDT\n\nTXabc',
      );
    });

    it('are cancelled by the same two lines, saying nothing of what was paid', () => {
      assert.equal(composeCopyCancelled(deal), '🔴 *حوالة ملغاة*\n\n+201008846989\n\n8130 جنيه');
    });

    it('cancel nothing for one only written down, which never went there', () => {
      assert.equal(
        composeCopyCancelled({ ...deal, counterpartyPhone: null, deliveredAmount: null }),
        null,
      );
    });
  });

  it('asks for the group of the deal’s own type', async () => {
    const asked: string[] = [];
    const { deps } = harness({
      target: async (type) => {
        asked.push(type);
        return GROUP;
      },
    });
    assert.equal(await announceDeal('t1', deps), 'SENT');
    assert.equal(asked.length, 1);
    assert.equal(asked[0], 'EXCHANGE');
  });

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
    assert.equal(kindLabel('WALLET_TOPUP'), 'إيداع في محفظة');
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
        return {
          reference: 'TXN-1',
          type: 'EXCHANGE',
          bankPayout: true,
          companyName: '',
          text: TEXT,
          phone: null,
        };
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

  it('keeps an exchange handed over in cash out of the group', async () => {
    const { deps, sent } = harness({ bankPayout: false });
    assert.equal(await announceDeal('t1', deps), 'SKIPPED');
    assert.equal(sent.length, 0);
  });

  it('still writes a USDT receipt paid out in cash', async () => {
    const { deps, sent } = harness({ type: 'USDT_RECEIVE', bankPayout: false });
    assert.equal(await announceDeal('t1', deps), 'SENT');
    assert.equal(sent.length, 2);
  });

  it('decides by kind and by how it was handed over', () => {
    assert.equal(announced({ type: 'EXCHANGE', bankPayout: false }), false);
    // A split payout has a transfer in it.
    assert.equal(announced({ type: 'EXCHANGE', bankPayout: true }), true);
    assert.equal(announced({ type: 'USDT_RECEIVE', bankPayout: false }), true);
    assert.equal(announced({ type: 'USDT_SEND', bankPayout: false }), true);
  });

  it('sends nothing when the office has not switched it on', async () => {
    const { deps, sent } = harness({ target: async () => null });
    assert.equal(await announceDeal('t1', deps), 'SKIPPED');
    assert.equal(sent.length, 0);
  });
});
