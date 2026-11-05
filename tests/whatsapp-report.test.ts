// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeReport,
  foldName,
  formatAmount,
  matchTellers,
  moveOf,
  parseCommand,
  senderAllowed,
  type TellerDay,
} from '../src/modules/whatsapp/report-command.ts';
import { handleReportCommand, type ReportDeps } from '../src/modules/whatsapp/report.service.ts';
import { paginate, reportImages, reportSvgs } from '../src/modules/whatsapp/report-image.ts';
import type { IncomingText } from '../src/modules/whatsapp/whatsapp.service.ts';

/**
 * «#جرد أحمد» from the group. Pinned: the code is a word of its own, only a
 * listed number gets an answer — anyone else gets silence — a name finds its
 * teller the way people type Arabic, and the report says the box and the deals.
 */

const UNIT = 100_000_000n;
const GROUP = '120363000000000000@g.us';

const tellers = [
  { id: 'u1', username: 'ahmad', fullNameAr: 'أحمد علي', fullNameEn: 'Ahmad Ali' },
  { id: 'u2', username: 'ahmadk', fullNameAr: 'أحمد خليل', fullNameEn: 'Ahmad Khalil' },
  { id: 'u3', username: 'sami', fullNameAr: 'سامي', fullNameEn: 'Sami' },
  { id: 'u4', username: 'fatima', fullNameAr: 'فاطمة', fullNameEn: 'Fatima' },
];

describe('the report command', () => {
  it('is the code as a word of its own, then a name', () => {
    assert.equal(parseCommand('#جرد سامي', '#جرد'), 'سامي');
    assert.equal(parseCommand('  #جرد   أحمد   علي ', '#جرد'), 'أحمد علي');
    assert.equal(parseCommand('#جرد', '#جرد'), '');
    assert.equal(parseCommand('#جردي', '#جرد'), null);
    assert.equal(parseCommand('مرحبا #جرد سامي', '#جرد'), null);
    assert.equal(parseCommand('#REPORT sami', '#report'), 'sami');
    assert.equal(parseCommand('#جرد سامي', ''), null);
  });

  it('answers only a listed number, however it is written', () => {
    const allowed = '0597085125, ٠٥٩٩١١١٢٢٢';
    assert.ok(senderAllowed('970597085125@s.whatsapp.net', allowed));
    assert.ok(senderAllowed('972599111222', allowed));
    assert.ok(!senderAllowed('970597000000@s.whatsapp.net', allowed));
    assert.ok(!senderAllowed(null, allowed));
    // Nobody listed means nobody.
    assert.ok(!senderAllowed('970597085125@s.whatsapp.net', ''));
  });

  it('finds a teller the way people type the name', () => {
    assert.equal(foldName('فاطمه'), foldName('فاطمة'));
    assert.deepEqual(
      matchTellers('فاطمه', tellers).map((u) => u.id),
      ['u4'],
    );
    assert.deepEqual(
      matchTellers('احمد علي', tellers).map((u) => u.id),
      ['u1'],
    );
    assert.deepEqual(
      matchTellers('أحمد', tellers).map((u) => u.id),
      ['u1', 'u2'],
    );
    assert.deepEqual(
      matchTellers('sami', tellers).map((u) => u.id),
      ['u3'],
    );
    assert.deepEqual(matchTellers('خالد', tellers), []);
  });

  it('writes amounts whole when whole, grouped by thousands', () => {
    assert.equal(formatAmount({ currency: 'ILS', amount: 12_500n * UNIT }), '12,500 شيكل');
    assert.equal(formatAmount({ currency: 'USD', amount: 150_050_000_000n }), '1,500.5 دولار');
    assert.equal(formatAmount({ currency: 'JOD', amount: -30n * UNIT }), '-30 دينار');
    // A currency without a word keeps its code.
    assert.equal(formatAmount({ currency: 'USDT', amount: 5n * UNIT }), '5 USDT');
  });

  it('says the box and the deals', () => {
    const day: TellerDay = {
      teller: 'سامي',
      day: '2026-10-31',
      asOf: '14:05',
      openingSet: true,
      cash: [
        {
          currency: 'ILS',
          opening: 5000n * UNIT,
          in: 3650n * UNIT,
          out: 1460n * UNIT,
          closing: 7190n * UNIT,
        },
        { currency: 'JOD', opening: 0n, in: 0n, out: 0n, closing: 0n },
      ],
      groups: [
        {
          kind: 'BUY',
          count: 2,
          received: [{ currency: 'USD', amount: 1000n * UNIT }],
          paid: [{ currency: 'ILS', amount: 3650n * UNIT }],
          receivedBank: [],
          paidBank: [{ currency: 'ILS', amount: 650n * UNIT }],
          moves: [],
        },
        {
          kind: 'SELL',
          count: 0,
          received: [],
          paid: [],
          receivedBank: [],
          paidBank: [],
          moves: [],
        },
        {
          kind: 'USDT_RECEIVE',
          count: 1,
          received: [{ currency: 'USDT', amount: 400n * UNIT }],
          paid: [{ currency: 'ILS', amount: 1460n * UNIT }],
          receivedBank: [],
          paidBank: [],
          moves: [],
        },
      ],
    };
    const text = composeReport(day);
    assert.match(text, /📊 جرد سامي/);
    assert.match(text, /دفع: 3,000 شيكل نقدي \+ 650 شيكل بنكي/);
    assert.match(text, /شيكل: افتتاح 5,000 شيكل \| داخل 3,650 شيكل \| خارج 1,460 شيكل/);
    assert.match(text, /المتبقي: \*7,190 شيكل\*/);
    // Whole words: «USDT» stays as it is.
    assert.doesNotMatch(text, /\bILS\b|\bUSD\b/);
    assert.doesNotMatch(text, /JOD/);
    assert.match(text, /شراء \(صرافة\): 2 عمليات/);
    assert.match(text, /استلام يواس: 1 عملية/);
    assert.doesNotMatch(text, /بيع \(صرافة\)/);
    assert.doesNotMatch(text, /لم يُدخل/);
  });
});

describe('answering in the group', () => {
  function harness(over: Partial<ReportDeps> = {}) {
    const replies: string[] = [];
    const pictures: { teller: string; caption: string }[] = [];
    let read = 0;
    const deps: ReportDeps = {
      config: async () => ({ group: GROUP, code: '#جرد', numbers: '0597085125' }),
      phoneOf: async (incoming) => incoming.senderPhone,
      tellers: async () => tellers,
      workedToday: async () => ['سامي', 'فاطمة'],
      dayOf: async (teller) => {
        read += 1;
        return {
          teller: teller.fullNameAr,
          day: '2026-10-31',
          asOf: '14:05',
          openingSet: false,
          cash: [],
          groups: [],
        };
      },
      reply: async (_incoming, text) => {
        replies.push(text);
      },
      replyImage: async (_incoming, day, caption) => {
        pictures.push({ teller: day.teller, caption });
      },
      ...over,
    };
    return { deps, replies, pictures, reads: () => read };
  }

  const message = (text: string, over: Partial<IncomingText> = {}): IncomingText => ({
    chat: GROUP,
    text,
    sender: '970597085125@s.whatsapp.net',
    senderPhone: '970597085125@s.whatsapp.net',
    message: {} as never,
    ...over,
  });

  it('answers a listed number with the teller’s day, as a picture', async () => {
    const { deps, replies, pictures } = harness();
    assert.equal(await handleReportCommand(message('#جرد سامي'), deps), 'REPORTED');
    assert.equal(replies.length, 0);
    assert.deepEqual(pictures, [{ teller: 'سامي', caption: 'جرد سامي — 2026-10-31 حتى 14:05' }]);
  });

  it('sends the same figures as text when the picture fails', async () => {
    const { deps, replies } = harness({
      replyImage: async () => {
        throw new Error('upload failed');
      },
    });
    assert.equal(await handleReportCommand(message('#جرد سامي'), deps), 'REPORTED_AS_TEXT');
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /جرد سامي/);
    assert.match(replies[0]!, /لم يُدخل التلر رصيد الافتتاح/);
  });

  it('is silent to anyone else, and reads nothing', async () => {
    const { deps, replies, pictures, reads } = harness();
    const stranger = message('#جرد سامي', {
      sender: '970599999999@s.whatsapp.net',
      senderPhone: '970599999999@s.whatsapp.net',
    });
    assert.equal(await handleReportCommand(stranger, deps), 'REFUSED');
    assert.equal(replies.length + pictures.length, 0);
    assert.equal(reads(), 0);
  });

  it('finds the number behind a hidden sender', async () => {
    const { deps, pictures } = harness({
      phoneOf: async (incoming) =>
        incoming.sender === '123456789@lid' ? '970597085125@s.whatsapp.net' : null,
    });
    const hidden = message('#جرد سامي', { sender: '123456789@lid', senderPhone: null });
    assert.equal(await handleReportCommand(hidden, deps), 'REPORTED');
    assert.equal(pictures.length, 1);
  });

  it('ignores other chats and other words', async () => {
    const { deps, replies } = harness();
    assert.equal(
      await handleReportCommand(message('#جرد سامي', { chat: 'other@g.us' }), deps),
      'IGNORED',
    );
    assert.equal(await handleReportCommand(message('صباح الخير'), deps), 'IGNORED');
    assert.equal(replies.length, 0);
  });

  it('explains how to ask, with who worked today', async () => {
    const { deps, replies } = harness();
    assert.equal(await handleReportCommand(message('#جرد'), deps), 'HELP');
    assert.match(replies[0]!, /#جرد سامي/);
    assert.match(replies[0]!, /• فاطمة/);
  });

  it('says when a name is unknown or means two tellers', async () => {
    const { deps, replies } = harness();
    assert.equal(await handleReportCommand(message('#جرد خالد'), deps), 'NOT_FOUND');
    assert.match(replies[0]!, /لم أجد تلر باسم «خالد»/);
    assert.equal(await handleReportCommand(message('#جرد أحمد'), deps), 'AMBIGUOUS');
    assert.match(replies[1]!, /أحمد علي/);
    assert.match(replies[1]!, /أحمد خليل/);
  });

  it('tells the manager when the day cannot be read', async () => {
    const { deps, replies } = harness({
      dayOf: async () => {
        throw new Error('database down');
      },
    });
    assert.equal(await handleReportCommand(message('#جرد سامي'), deps), 'FAILED');
    assert.match(replies[0]!, /تعذّرت/);
  });

  it('does nothing until the office lists a number', async () => {
    const { deps, replies } = harness({
      config: async () => ({ group: GROUP, code: '#جرد', numbers: '' }),
    });
    assert.equal(await handleReportCommand(message('#جرد سامي'), deps), 'REFUSED');
    assert.equal(replies.length, 0);
  });
});

describe('the report as a picture', () => {
  const move = (over = {}) => ({
    at: '09:55',
    goods: { currency: 'USD', amount: 100n * UNIT },
    price: '3.65',
    counter: { currency: 'ILS', amount: 365n * UNIT },
    customer: null as string | null,
    byBank: false,
    ...over,
  });
  const day: TellerDay = {
    teller: 'سامي',
    day: '2026-10-31',
    asOf: '14:05',
    openingSet: true,
    cash: [{ currency: 'ILS', opening: 0n, in: 0n, out: 1095n * UNIT, closing: -1095n * UNIT }],
    groups: [
      {
        kind: 'BUY',
        count: 2,
        received: [{ currency: 'USD', amount: 300n * UNIT }],
        paid: [{ currency: 'ILS', amount: 730n * UNIT }],
        receivedBank: [],
        paidBank: [{ currency: 'ILS', amount: 365n * UNIT }],
        moves: [move({ customer: 'فادي ابو حجر', byBank: true }), move({ at: '10:20' })],
      },
      {
        kind: 'USDT_RECEIVE',
        count: 1,
        received: [{ currency: 'USDT', amount: 400n * UNIT }],
        paid: [{ currency: 'USD', amount: 396n * UNIT }],
        receivedBank: [],
        paidBank: [],
        moves: [
          move({
            goods: { currency: 'USDT', amount: 400n * UNIT },
            price: '0.99',
            counter: { currency: 'USD', amount: 396n * UNIT },
          }),
        ],
      },
    ],
  };
  const many = (n: number) => Array.from({ length: n }, (_, i) => move({ at: String(i) }));
  const busy = (n: number): TellerDay => ({
    ...day,
    groups: [{ ...day.groups[0]!, count: n, moves: many(n) }],
  });

  it('says the same figures, a box below zero in red', () => {
    const [svg] = reportSvgs(day, 'انترنشونال');
    // The figure and its currency word drawn apart, so they read right to left.
    assert.match(svg!, /جرد سامي/);
    assert.match(svg!, />300</);
    assert.match(svg!, />دولار</);
    assert.match(svg!, /fill="#b91c1c"[^>]*>-1,095</);
    assert.doesNotMatch(svg!, /bUSDb|bILSb/);
    assert.doesNotMatch(svg!, /\*/);
  });

  it('lists each deal under its kind, with its price and customer', () => {
    const [svg] = reportSvgs(day);
    assert.match(svg!, /حركات الشراء \(صرافة\)/);
    assert.match(svg!, /شراء يواس \(استلام\)/);
    assert.doesNotMatch(svg!, /حركات البيع/);
    assert.match(svg!, />09:55</);
    assert.match(svg!, />10:20</);
    assert.match(svg!, />3\.65</);
    assert.match(svg!, />0\.99</);
    assert.match(svg!, /بنكي · فادي ابو حجر/);
  });

  it('tells cash from bank in the totals, and leaves the coins as they are', () => {
    const [svg] = reportSvgs(day);
    assert.match(svg!, />365<\/text><text[^>]*>شيكل نقدي</);
    assert.match(svg!, />365<\/text><text[^>]*>شيكل بنكي</);
    assert.match(svg!, />400<\/text><text[^>]*>USDT</);
  });

  it('ends each list with its sums, once, even across pictures', () => {
    const [svg] = reportSvgs(day);
    assert.equal(svg!.match(/>مجموع</g)?.length, 2);
    assert.match(svg!, />200<\/text><text[^>]*>دولار</);
    assert.match(svg!, />730<\/text><text[^>]*>شيكل</);

    const pages = paginate(busy(100));
    const parts = pages.flat();
    assert.equal(parts.filter((part) => part.totals).length, 1);
    assert.ok(parts.at(-1)!.totals);
    assert.ok(parts.at(-1)!.moves.length > 0, 'a total does not go over alone');
    assert.deepEqual(parts.at(-1)!.totals!.goods, [{ currency: 'USD', amount: 10_000n * UNIT }]);
  });

  it('lists sent remittances with what was taken and the correspondent’s price', () => {
    const [svg] = reportSvgs({
      ...day,
      groups: [
        {
          kind: 'REMITTANCE_OUT',
          count: 1,
          received: [{ currency: 'ILS', amount: 1000n * UNIT }],
          paid: [],
          receivedBank: [],
          paidBank: [],
          moves: [
            moveOf('REMITTANCE_OUT', {
              at: '11:00',
              fromCurrency: 'ILS',
              fromAmount: 1000n * UNIT,
              toCurrency: 'ILS',
              toAmount: 980n * UNIT,
              customer: 'حوالات الصباح',
              intakeBank: 0n,
              payoutBank: 0n,
            }),
          ],
        },
      ],
    });
    assert.match(svg!, /حوالات صادرة/);
    assert.match(svg!, />1,000<\/text><text[^>]*>شيكل نقدي</);
    assert.match(svg!, /تسعيرة المراسل/);
    assert.match(svg!, />980</);
    assert.match(svg!, /حوالات الصباح/);
    assert.doesNotMatch(svg!, />1\.02</);
  });

  it('lists wallet top-ups: what went in, what was taken, and their sums', () => {
    const top = moveOf('WALLET_TOPUP', {
      at: '12:42',
      fromCurrency: 'ILS',
      fromAmount: 1515n * UNIT,
      toCurrency: 'ILS',
      toAmount: 1500n * UNIT,
      customer: 'اسامة',
      intakeBank: 0n,
      payoutBank: 1500n * UNIT,
    });
    assert.equal(top.goods.amount, 1500n * UNIT, 'what went into the wallet');
    assert.equal(top.counter.amount, 1515n * UNIT, 'what the customer handed over');
    assert.equal(top.price, null, 'the gap is a fee');
    assert.equal(top.byBank, true);
    const [svg] = reportSvgs({
      ...day,
      groups: [
        {
          kind: 'WALLET_TOPUP',
          count: 2,
          received: [{ currency: 'ILS', amount: 3030n * UNIT }],
          paid: [{ currency: 'ILS', amount: 3000n * UNIT }],
          receivedBank: [],
          paidBank: [{ currency: 'ILS', amount: 3000n * UNIT }],
          moves: [top, top],
        },
      ],
    });
    assert.match(svg!, /الإيداع في محفظة/);
    assert.match(svg!, /أودعنا/);
    assert.match(svg!, />3,000<\/text><text[^>]*>شيكل بنكي</);
    assert.match(svg!, />3,030<\/text><text[^>]*>شيكل نقدي</);
    assert.equal(svg!.match(/>مجموع</g)?.length, 1);
    assert.doesNotMatch(svg!, />1\.01</);
  });

  it('says a remittance has no price yet, and leaves it out of the sum', () => {
    const noPrice = moveOf('REMITTANCE_OUT', {
      at: '11:00',
      fromCurrency: 'ILS',
      fromAmount: 1000n * UNIT,
      toCurrency: 'ILS',
      toAmount: 0n,
      customer: null,
      intakeBank: 0n,
      payoutBank: 0n,
    });
    const priced = { ...noPrice, counter: { currency: 'ILS', amount: 980n * UNIT } };
    const remittances = (moves: (typeof noPrice)[]): TellerDay => ({
      ...day,
      groups: [
        {
          kind: 'REMITTANCE_OUT',
          count: moves.length,
          received: [{ currency: 'ILS', amount: 1000n * UNIT }],
          paid: [],
          receivedBank: [],
          paidBank: [],
          moves,
        },
      ],
    });
    const [mixed] = reportSvgs(remittances([noPrice, priced]));
    assert.match(mixed!, /بلا تسعيرة/);
    assert.match(mixed!, />2,000<\/text><text[^>]*>شيكل</);
    assert.equal(mixed!.match(/>980</g)?.length, 2, 'the deal and the sum: only the priced one');
    assert.match(composeReport(remittances([noPrice])), /= بلا تسعيرة/);
  });

  it('lists a remittance paid out by what was handed over', () => {
    const paid = moveOf('REMITTANCE_IN', {
      at: '11:00',
      fromCurrency: 'ILS',
      fromAmount: 1020n * UNIT,
      toCurrency: 'ILS',
      toAmount: 1000n * UNIT,
      customer: 'تركيا',
      intakeBank: 0n,
      payoutBank: 0n,
    });
    assert.equal(paid.goods.amount, 1000n * UNIT, 'what the customer took');
    assert.equal(paid.counter.amount, 1020n * UNIT, 'what the correspondent credits');
    assert.equal(paid.price, null);
    const [svg] = reportSvgs({
      ...day,
      groups: [
        {
          kind: 'REMITTANCE_IN',
          count: 1,
          received: [],
          paid: [{ currency: 'ILS', amount: 1000n * UNIT }],
          receivedBank: [],
          paidBank: [],
          moves: [paid],
        },
      ],
    });
    assert.match(svg!, /الحوالات الواردة/);
    assert.match(svg!, /سلّمنا/);
    assert.match(svg!, /قيد المراسل/);
    assert.match(svg!, />1,000<\/text><text[^>]*>شيكل نقدي</);
  });

  it('keeps a total on the page of its last deal, however the deals fall', () => {
    for (let n = 1; n < 80; n += 1) {
      const parts = paginate(busy(n)).flat();
      assert.equal(parts.reduce((sum, part) => sum + part.moves.length, 0), n);
      assert.equal(parts.filter((part) => part.totals).length, 1);
      assert.ok(parts.at(-1)!.totals && parts.at(-1)!.moves.length > 0, `${n} deals`);
    }
  });

  it('keeps an ordinary day on one picture', () => {
    assert.equal(reportSvgs(day).length, 1);
  });

  it('runs a long day across pictures, losing no deal and numbering them', () => {
    const pages = paginate(busy(100));
    assert.ok(pages.length > 1);
    const listed = pages.flat().flatMap((part) => part.moves);
    assert.equal(listed.length, 100);
    assert.deepEqual(
      listed.map((entry) => entry.at),
      many(100).map((entry) => entry.at),
    );
    const svgs = reportSvgs(busy(100));
    assert.equal(svgs.length, pages.length);
    assert.match(svgs[1]!, /صفحة 2 من/);
    assert.match(svgs[1]!, /\(تابع\)/);
    // The box and totals only open the first.
    assert.match(svgs[0]!, /الصندوق/);
    assert.doesNotMatch(svgs[1]!, /الصندوق/);
  });

  it('holds every picture short enough to stay readable', () => {
    for (const svg of reportSvgs(busy(200))) {
      const height = Number(/height="(\d+)"/.exec(svg)![1]);
      assert.ok(height < 2000, `${height}`);
    }
  });

  it('draws PNGs from the font shipped with the code', () => {
    const [png] = reportImages(day);
    assert.deepEqual([...png!.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(png!.length > 10_000);
  });

  it('keeps a name that would break the drawing as text', () => {
    const [svg] = reportSvgs({ ...day, teller: 'A <b> & "C"' });
    assert.match(svg!, /A &lt;b&gt; &amp; &quot;C&quot;/);
  });
});

describe('a deal as its list reads it', () => {
  const deal = {
    at: '09:55',
    customer: 'سامي',
    intakeBank: 0n,
    payoutBank: 0n,
  };

  it('has the goods on what was handed over when buying', () => {
    const move = moveOf('BUY', {
      ...deal,
      fromCurrency: 'USD',
      fromAmount: 100n * UNIT,
      toCurrency: 'ILS',
      toAmount: 365n * UNIT,
    });
    assert.deepEqual(move.goods, { currency: 'USD', amount: 100n * UNIT });
    assert.deepEqual(move.counter, { currency: 'ILS', amount: 365n * UNIT });
    assert.equal(move.price, '3.65');
  });

  it('has the goods on what was taken away when selling', () => {
    const move = moveOf('SELL', {
      ...deal,
      fromCurrency: 'ILS',
      fromAmount: 370n * UNIT,
      toCurrency: 'USD',
      toAmount: 100n * UNIT,
    });
    assert.deepEqual(move.goods, { currency: 'USD', amount: 100n * UNIT });
    assert.equal(move.price, '3.7');
  });

  it('reads USDT the same way, both directions', () => {
    const bought = moveOf('USDT_RECEIVE', {
      ...deal,
      fromCurrency: 'USDT',
      fromAmount: 1000n * UNIT,
      toCurrency: 'USD',
      toAmount: 990n * UNIT,
      payoutBank: 990n * UNIT,
    });
    assert.equal(bought.goods.currency, 'USDT');
    assert.equal(bought.price, '0.99');
    assert.equal(bought.byBank, true);

    const sold = moveOf('USDT_SEND', {
      ...deal,
      fromCurrency: 'ILS',
      fromAmount: 365n * UNIT,
      toCurrency: 'USDT',
      toAmount: 100n * UNIT,
    });
    assert.equal(sold.goods.currency, 'USDT');
    assert.equal(sold.price, '3.65');
  });
});
