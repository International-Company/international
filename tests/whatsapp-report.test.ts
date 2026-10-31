// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeReport,
  foldName,
  formatAmount,
  matchTellers,
  parseCommand,
  senderAllowed,
  type TellerDay,
} from '../src/modules/whatsapp/report-command.ts';
import { handleReportCommand, type ReportDeps } from '../src/modules/whatsapp/report.service.ts';
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
    assert.equal(formatAmount({ currency: 'ILS', amount: 12_500n * UNIT }), '12,500 ILS');
    assert.equal(formatAmount({ currency: 'USD', amount: 150_050_000_000n }), '1,500.5 USD');
    assert.equal(formatAmount({ currency: 'ILS', amount: -30n * UNIT }), '-30 ILS');
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
        },
        { kind: 'SELL', count: 0, received: [], paid: [] },
        {
          kind: 'USDT_RECEIVE',
          count: 1,
          received: [{ currency: 'USDT', amount: 400n * UNIT }],
          paid: [{ currency: 'ILS', amount: 1460n * UNIT }],
        },
      ],
    };
    const text = composeReport(day);
    assert.match(text, /📊 جرد سامي/);
    assert.match(text, /ILS: افتتاح 5,000 ILS \| داخل 3,650 ILS \| خارج 1,460 ILS/);
    assert.match(text, /المتبقي: \*7,190 ILS\*/);
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
      ...over,
    };
    return { deps, replies, reads: () => read };
  }

  const message = (text: string, over: Partial<IncomingText> = {}): IncomingText => ({
    chat: GROUP,
    text,
    sender: '970597085125@s.whatsapp.net',
    senderPhone: '970597085125@s.whatsapp.net',
    message: {} as never,
    ...over,
  });

  it('answers a listed number with the teller’s day', async () => {
    const { deps, replies } = harness();
    assert.equal(await handleReportCommand(message('#جرد سامي'), deps), 'REPORTED');
    assert.equal(replies.length, 1);
    assert.match(replies[0]!, /جرد سامي/);
    assert.match(replies[0]!, /لم يُدخل التلر رصيد الافتتاح/);
  });

  it('is silent to anyone else, and reads nothing', async () => {
    const { deps, replies, reads } = harness();
    const stranger = message('#جرد سامي', {
      sender: '970599999999@s.whatsapp.net',
      senderPhone: '970599999999@s.whatsapp.net',
    });
    assert.equal(await handleReportCommand(stranger, deps), 'REFUSED');
    assert.equal(replies.length, 0);
    assert.equal(reads(), 0);
  });

  it('finds the number behind a hidden sender', async () => {
    const { deps, replies } = harness({
      phoneOf: async (incoming) =>
        incoming.sender === '123456789@lid' ? '970597085125@s.whatsapp.net' : null,
    });
    const hidden = message('#جرد سامي', { sender: '123456789@lid', senderPhone: null });
    assert.equal(await handleReportCommand(hidden, deps), 'REPORTED');
    assert.equal(replies.length, 1);
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
