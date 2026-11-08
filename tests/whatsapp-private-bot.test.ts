// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseAccount, isPrivateChat } from '../src/modules/whatsapp/accounts.ts';
import { categoriesOf, groupPlan } from '../src/modules/whatsapp/group-routes.ts';
import { composePriceSheet } from '../src/modules/whatsapp/price-sheet.ts';
import {
  handlePrivateMessage,
  newBotState,
  type Answer,
  type BotDeps,
} from '../src/modules/whatsapp/private-bot.service.ts';
import type { IncomingText } from '../src/modules/whatsapp/whatsapp.service.ts';

const U = 100_000_000n;
const message = (text: string, chat = '970599000000@s.whatsapp.net') =>
  ({ chat, text, sender: chat, senderPhone: chat, message: {}, account: 'private' }) as unknown as IncomingText;

const setup = (answer: Answer | Error = { reply: 'الدولار 3.15', handover: false, summary: null }, limit: number | null = 100) => {
  const sent: string[] = [];
  const alerts: string[] = [];
  const asked: { role: string; content: string }[][] = [];
  let clock = new Date(2026, 10, 8, 10, 0).getTime();
  const deps: BotDeps = {
    dailyLimit: async () => limit,
    ask: async (turns) => {
      asked.push(turns);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    reply: async (_chat, text) => void sent.push(text),
    alert: async (text) => void alerts.push(text),
    state: newBotState(),
    now: () => new Date(clock),
  };
  return { deps, sent, alerts, asked, pass: (ms: number) => (clock += ms) };
};

describe('the private number', () => {
  it('stays silent while switched off or not set up', async () => {
    const { deps, sent, asked } = setup(undefined, null);
    assert.equal(await handlePrivateMessage(message('سلام'), deps), 'OFF');
    assert.deepEqual([sent.length, asked.length], [0, 0]);
  });

  it('answers, and follows the conversation', async () => {
    const { deps, sent, asked } = setup();
    assert.equal(await handlePrivateMessage(message('كم الدولار؟'), deps), 'ANSWERED');
    await handlePrivateMessage(message('والدينار؟'), deps);
    assert.deepEqual(sent, ['الدولار 3.15', 'الدولار 3.15']);
    assert.deepEqual(asked[1]!.map((turn) => turn.content), ['كم الدولار؟', 'الدولار 3.15', 'والدينار؟']);
    assert.equal(asked[1]!.at(-1)!.role, 'user');
  });

  it('keeps one customer’s conversation from another', async () => {
    const { deps, asked } = setup();
    await handlePrivateMessage(message('أنا الأول', 'a@s.whatsapp.net'), deps);
    await handlePrivateMessage(message('أنا الثاني', 'b@s.whatsapp.net'), deps);
    assert.equal(asked[1]!.length, 1);
  });

  it('tells the group when someone wants a person, once for a while', async () => {
    const { deps, alerts, pass } = setup({ reply: 'سيتواصل معك موظف', handover: true, summary: 'يريد بيع 1000 دولار' });
    await handlePrivateMessage(message('بدي أبيع 1000 دولار'), deps);
    assert.equal(alerts[0], '🔔 *طلب من عميل*\nالرقم: +970599000000\nالطلب: يريد بيع 1000 دولار');
    await handlePrivateMessage(message('وينكم؟'), deps);
    assert.equal(alerts.length, 1);
    pass(31 * 60 * 1000);
    await handlePrivateMessage(message('ردوا علي'), deps);
    assert.equal(alerts.length, 2);
  });

  it('when it cannot answer, says so and a person is told', async () => {
    const { deps, sent, alerts } = setup(new Error('down'));
    assert.equal(await handlePrivateMessage(message('كم السعر'), deps), 'UNAVAILABLE');
    assert.match(sent[0]!, /سيتواصل معك/);
    assert.match(alerts[0]!, /الطلب: كم السعر/);
  });

  it('stops asking at the day’s limit, and starts again the next day', async () => {
    const { deps, asked, sent, pass } = setup(undefined, 1);
    await handlePrivateMessage(message('1'), deps);
    assert.equal(await handlePrivateMessage(message('2'), deps), 'UNAVAILABLE');
    assert.equal(asked.length, 1);
    assert.equal(sent.length, 2);
    pass(24 * 60 * 60 * 1000);
    assert.equal(await handlePrivateMessage(message('3'), deps), 'ANSWERED');
  });

  it('goes quiet on a number that floods it', async () => {
    const { deps, sent, pass } = setup();
    for (let i = 0; i < 12; i += 1) await handlePrivateMessage(message(`س${i}`), deps);
    assert.equal(await handlePrivateMessage(message('المزيد'), deps), 'LIMITED');
    assert.equal(sent.length, 12);
    pass(11 * 60 * 1000);
    assert.equal(await handlePrivateMessage(message('الآن'), deps), 'ANSWERED');
  });

  it('asks for a shorter message without spending an answer', async () => {
    const { deps, asked } = setup();
    assert.equal(await handlePrivateMessage(message('س'.repeat(801)), deps), 'TOO_LONG');
    assert.equal(asked.length, 0);
  });
});

describe('the private number among the others', () => {
  it('answers people, never groups or broadcasts', () => {
    assert.equal(isPrivateChat('970599000000@s.whatsapp.net'), true);
    assert.equal(isPrivateChat('123456@lid'), true);
    assert.equal(isPrivateChat('123@g.us'), false);
    assert.equal(isPrivateChat('status@broadcast'), false);
    assert.equal(isPrivateChat('123@newsletter'), false);
  });

  it('has its alerts sent only to a group chosen for them', () => {
    const routes = { PRIVATE_LEADS: { id: 'leads@g.us', name: 'العملاء' } };
    assert.deepEqual(categoriesOf('leads@g.us', routes, 'main@g.us'), ['PRIVATE_LEADS']);
    assert.equal(categoriesOf('main@g.us', {}, 'main@g.us').includes('PRIVATE_LEADS'), false);
    assert.equal(groupPlan({}, 'main@g.us').length, 1);
  });

  it('leaves the choosing of a sender to the group numbers', () => {
    assert.equal(chooseAccount('g@g.us', ['second'], { second: new Set(['g@g.us']) }), 'second');
  });
});

describe('the price sheet', () => {
  const sheet = composePriceSheet({
    rates: [
      { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 310_000_000n, sellRate: 315_000_000n },
      { baseCode: 'USD', quoteCode: 'ILS', channel: 'BROKER', buyRate: 308_000_000n, sellRate: 0n },
    ],
    remittances: [
      { destination: 'مصر', currency: 'ILS', chargeKind: 'PERCENT', chargeValue: 2n * U },
      { destination: 'الأردن', currency: 'USD', chargeKind: 'FLAT', chargeValue: 10n * U },
    ],
    usdtForCashDollars: 1,
    usdtForBankDollars: 0,
  });

  it('says each side, cash and bank, and leaves out a side with no price', () => {
    assert.match(sheet, /- الدولار مقابل الشيكل، نقداً: نشتريه من العميل بـ 3\.1، نبيعه للعميل بـ 3\.15 الشيكل/);
    assert.match(sheet, /- الدولار مقابل الشيكل، بتحويل بنكي: نشتريه من العميل بـ 3\.08 الشيكل/);
  });

  it('says remittance fees, and the USDT percentage only when one is set', () => {
    assert.match(sheet, /إلى مصر بعملة الشيكل: الرسوم 2%/);
    assert.match(sheet, /إلى الأردن بعملة الدولار: الرسوم 10 الدولار/);
    assert.match(sheet, /دولاراً نقدياً: نخصم 1%/);
    assert.doesNotMatch(sheet, /بتحويل بنكي: نخصم/);
  });

  it('says so when nothing is published', () => {
    const empty = composePriceSheet({ rates: [], remittances: [], usdtForCashDollars: 0, usdtForBankDollars: 0 });
    assert.match(empty, /لا توجد أسعار منشورة/);
  });
});
