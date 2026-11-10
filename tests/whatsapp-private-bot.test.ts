// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseAccount, groupEntry, isPrivateChat } from '../src/modules/whatsapp/accounts.ts';
import { categoriesOf, groupPlan, groupsMatching } from '../src/modules/whatsapp/group-routes.ts';
import { composePriceSheet } from '../src/modules/whatsapp/price-sheet.ts';
import {
  composeChoices,
  emptyPick,
  renderAnswer,
  SAY_TO_STAFF,
  type BotPick,
} from '../src/modules/whatsapp/bot-answers.ts';
import { calculationLines } from '../src/modules/whatsapp/bot-calc.ts';
import { priceFor, quoteCountry, type CountryPrice } from '../src/modules/whatsapp/country-prices.ts';
import {
  currentMenu,
  enterFlow,
  FLOW_EXPIRES,
  quoteStep,
  stepFlow,
  type FlowState,
} from '../src/modules/whatsapp/bot-flows.ts';
import {
  cannedWelcome,
  composeKnowledge,
  composeRules,
  emptyProfile,
  firstMatch,
  isGreeting,
  officeOpen,
  parseProfile,
  profileSchema,
  tidyProfile,
  visibleSheet,
  type BotProfile,
  type FlowNode,
} from '../src/modules/whatsapp/bot-profile.ts';
import {
  forwardToGroup,
  gapsOf,
  handlePrivateMessage,
  newBotState,
  type Answer,
  type BotDeps,
  type ForwardDeps,
} from '../src/modules/whatsapp/private-bot.service.ts';
import type { ForwardedMedia, IncomingText } from '../src/modules/whatsapp/whatsapp.service.ts';

const U = 100_000_000n;
const message = (text: string, chat = '970599000000@s.whatsapp.net') =>
  ({ chat, text, sender: chat, senderPhone: chat, message: {}, account: 'private' }) as unknown as IncomingText;

const setup = (
  answer: Answer | Error = { reply: 'الدولار 3.15', handover: false, summary: null },
  limit: number | null = 100,
  profile: BotProfile = emptyProfile(),
) => {
  const sent: string[] = [];
  const alerts: string[] = [];
  const asked: { role: string; content: string }[][] = [];
  const kept: string[] = [];
  const raised: string[] = [];
  const paused = { on: false };
  let clock = new Date(2026, 10, 8, 10, 0).getTime();
  const deps: BotDeps = {
    dailyLimit: async () => limit,
    ask: async (turns) => {
      asked.push(turns);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    welcome: async (isFirst, text) => cannedWelcome(isFirst, text, profile),
    guards: async () => profile,
    paused: async () => paused.on,
    record: async (_chat, _phone, role, text) => void kept.push(`${role}:${text}`),
    raise: async (_chat, _phone, summary) => void raised.push(summary),
    reply: async (_chat, text) => void sent.push(text),
    alert: async (text) => void alerts.push(text),
    state: newBotState(),
    now: () => new Date(clock),
  };
  return { deps, sent, alerts, asked, kept, raised, paused, pass: (ms: number) => (clock += ms) };
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
    assert.match(sent[0]!, /رح يتواصل معك/);
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

describe('what the manager tells it', () => {
  const profile = (over: Partial<BotProfile> = {}): BotProfile => ({ ...emptyProfile(), ...over });
  const sheet = {
    rates: [
      { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 3n * U, sellRate: 4n * U },
      { baseCode: 'USD', quoteCode: 'ILS', channel: 'BROKER', buyRate: 3n * U, sellRate: 4n * U },
      { baseCode: 'JOD', quoteCode: 'ILS', channel: 'CASH', buyRate: 4n * U, sellRate: 5n * U },
      { baseCode: 'USDT', quoteCode: 'ILS', channel: 'CASH', buyRate: 3n * U, sellRate: 4n * U },
    ],
    remittances: [
      { destination: 'مصر', currency: 'ILS', chargeKind: 'FLAT', chargeValue: U },
      { destination: 'الأردن', currency: 'ILS', chargeKind: 'FLAT', chargeValue: U },
    ],
    usdtForCashDollars: 1,
    usdtForBankDollars: 2,
  };

  it('shows everything until told otherwise', () => {
    const seen = visibleSheet(sheet, profile());
    assert.equal(seen.rates.length, 4);
    assert.equal(seen.remittances.length, 2);
  });

  it('cuts sections, currencies and destinations before the assistant sees them', () => {
    const noCash = visibleSheet(sheet, profile({ show: { ...emptyProfile().show, cash: false } }));
    assert.deepEqual(noCash.rates.map((r) => `${r.baseCode}:${r.channel}`), ['USD:BROKER', 'USDT:CASH']);
    const noUsdt = visibleSheet(sheet, profile({ show: { ...emptyProfile().show, usdt: false } }));
    assert.equal(noUsdt.rates.some((r) => r.baseCode === 'USDT'), false);
    assert.equal(noUsdt.usdtForCashDollars + noUsdt.usdtForBankDollars, 0);
    const noJod = visibleSheet(sheet, profile({ hiddenCurrencies: ['JOD'] }));
    assert.equal(noJod.rates.some((r) => r.baseCode === 'JOD'), false);
    const noJordan = visibleSheet(sheet, profile({ hiddenDestinations: ['الأردن'] }));
    assert.deepEqual(noJordan.remittances.map((r) => r.destination), ['مصر']);
    const none = visibleSheet(sheet, profile({ show: { ...emptyProfile().show, remittances: false } }));
    assert.deepEqual(none.remittances, []);
  });

  it('adds the prices the office wrote in', () => {
    const text = composePriceSheet(visibleSheet(sheet, profile({ extraPrices: [{ item: 'الدرهم', buy: '0.85', sell: '0.90' }, { item: 'الريال', buy: '', sell: '0.80' }] })));
    assert.match(text, /أسعار أخرى من المكتب:\n- الدرهم: نشتري بـ 0\.85، نبيع بـ 0\.90\n- الريال: نبيع بـ 0\.80/);
  });

  it('drops rows left half empty, and reads a broken save as nothing written', () => {
    const tidy = tidyProfile(profile({ faqs: [{ question: ' س ', answer: ' ج ' }, { question: 'بلا جواب', answer: ' ' }], extraPrices: [{ item: '', buy: '1', sell: '' }, { item: 'بلا سعر', buy: ' ', sell: '' }] }));
    assert.deepEqual(tidy.faqs, [{ question: 'س', answer: 'ج' }]);
    assert.deepEqual(tidy.extraPrices, []);
    assert.deepEqual(parseProfile('{not json'), emptyProfile());
    assert.deepEqual(parseProfile(''), profileSchema.parse({}));
  });

  it('knows a greeting from a question', () => {
    for (const text of ['السلام عليكم', 'السلام عليكم ورحمة الله وبركاته', 'مرحبا', 'مرحباً!', 'صباح الخير 🌹', 'هلا', 'Hello', 'مرحبا السلام عليكم']) {
      assert.equal(isGreeting(text), true, text);
    }
    for (const text of ['السلام عليكم كم الدولار', 'مرحبا بدي احول', 'كم السعر؟', '🌹', '']) {
      assert.equal(isGreeting(text), false, text);
    }
  });

  it('greets a first hello in the office’s words, at no cost, and only the first', async () => {
    const { deps, sent, asked } = setup(undefined, 0, profile({ welcome: 'أهلاً بك' }));
    assert.equal(await handlePrivateMessage(message('السلام عليكم'), deps), 'WELCOMED');
    assert.deepEqual(sent, ['أهلاً بك']);
    assert.equal(asked.length, 0);
    assert.equal(await handlePrivateMessage(message('مرحبا'), deps), 'UNAVAILABLE');
  });

  it('leaves a first question, or a hello with no greeting written, to the assistant', async () => {
    const written = setup(undefined, 100, profile({ welcome: 'أهلاً بك' }));
    assert.equal(await handlePrivateMessage(message('كم الدولار؟'), written.deps), 'ANSWERED');
    const unwritten = setup();
    assert.equal(await handlePrivateMessage(message('مرحبا'), unwritten.deps), 'ANSWERED');
  });
});

describe('answers made of the office’s own words', () => {
  const rates = [
    { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 365_000_000n, sellRate: 370_000_000n },
    { baseCode: 'USD', quoteCode: 'ILS', channel: 'BROKER', buyRate: 362_000_000n, sellRate: 0n },
    { baseCode: 'JOD', quoteCode: 'ILS', channel: 'CASH', buyRate: 512_000_000n, sellRate: 525_000_000n },
  ];
  const sheet = {
    rates,
    remittances: [{ destination: 'مصر', currency: 'ILS', chargeKind: 'PERCENT', chargeValue: 2n * U }],
    usdtForCashDollars: 1,
    usdtForBankDollars: 0,
    extra: [{ item: 'الدرهم', buy: '0.85', sell: '0.90' }],
  };
  const account = { bank: 'بنك فلسطين', name: 'مكتب انترنشونال', account: 'PS92PALS0000' };
  const profile = (over: Partial<BotProfile> = {}): BotProfile => ({
    ...emptyProfile(),
    about: 'نعمل من 9 حتى 6',
    faqs: [{ question: 'متى تفتحون؟', answer: 'الساعة 9 بالضبط' }],
    accounts: [account, { bank: 'جوال باي', name: 'أحمد', account: '0599' }],
    ...over,
  });
  const pick = (over: Partial<BotPick>): BotPick => emptyPick(over);
  const say = (over: Partial<BotPick>, p = profile(), open = true) => renderAnswer(pick(over), p, sheet, open);

  it('sends a prepared answer word for word', () => {
    assert.equal(say({ intent: 'faq', faq_index: 0 }).reply, 'الساعة 9 بالضبط');
  });

  it('stays silent on what the office has written nothing for', () => {
    assert.equal(say({ intent: 'none' }).reply, null);
    assert.equal(say({ intent: 'faq', faq_index: 9 }).reply, null);
    assert.equal(say({ intent: 'about' }, profile({ about: '' })).reply, null);
    assert.equal(say({ intent: 'price', currencies: ['GBP'] }).reply, null);
  });

  it('gives one bank’s account exactly as typed', () => {
    assert.equal(
      say({ intent: 'account', account_index: 0 }).reply,
      'بنك فلسطين\nالاسم: مكتب انترنشونال\nرقم الحساب: PS92PALS0000',
    );
    assert.equal(say({ intent: 'account', account_index: 7 }).reply, null);
  });

  it('asks which bank when none was named, and gives the only one if there is one', () => {
    assert.equal(say({ intent: 'account_list' }).reply, 'أي بنك بدك؟\n• بنك فلسطين\n• جوال باي');
    assert.match(say({ intent: 'account_list' }, profile({ accounts: [account] })).reply!, /PS92PALS0000/);
    assert.equal(say({ intent: 'account_list' }, profile({ accounts: [] })).reply, null);
  });

  it('never gives the assistant an account number, a price or an answer', () => {
    const choices = composeChoices(profile(), sheet);
    assert.match(choices, /0: بنك فلسطين/);
    assert.match(choices, /0: متى تفتحون؟/);
    assert.doesNotMatch(choices, /PS92PALS0000|الساعة 9|3\.65|0\.85|مكتب انترنشونال/);
  });

  it('gives prices from the book, one way of paying when that was asked', () => {
    assert.equal(
      say({ intent: 'price', currencies: ['USD'], channel: 'CASH' }).reply,
      'دولار مقابل شيكل (نقدي): نشتري بـ 3.65، نبيع بـ 3.7\nوالسعر ممكن يتغير.',
    );
    assert.match(say({ intent: 'price', currencies: ['USD'] }).reply!, /تحويل بنكي\): نشتري بـ 3\.62\n/);
    assert.match(say({ intent: 'price', currencies: ['USDT'] }).reply!, /نخصم 1%/);
  });

  it('gives remittance fees and the office’s other prices', () => {
    assert.match(say({ intent: 'remittance', destination: 'مصر' }).reply!, /الرسوم 2%/);
    assert.match(say({ intent: 'extra', extra_index: 0 }).reply!, /الدرهم: نشتري بـ 0\.85، نبيع بـ 0\.90/);
  });

  it('works sums out, and hands a wanted deal to staff with them', () => {
    const answer = say({
      intent: 'calculation',
      wants_staff: true,
      summary: 'يريد بيع 1000 دولار',
      calculation: { side: 'customer_sells', currency: 'USD', amount: '1000', other_currency: 'ILS', channel: 'CASH' },
    });
    assert.equal(answer.reply, '1,000 دولار = 3,650 شيكل (نقدي)\nوالسعر ممكن يتغير.\n' + SAY_TO_STAFF);
    assert.equal(answer.handover, true);
    assert.equal(answer.summary, 'يريد بيع 1000 دولار');
  });

  it('says the office is closed when it hands over out of hours', () => {
    assert.match(say({ intent: 'handover' }, profile(), false).reply!, /المكتب مغلق الآن/);
    assert.equal(say({ intent: 'handover' }).reply, SAY_TO_STAFF);
  });

  it('greets with the office’s welcome, or a short hello', () => {
    assert.equal(say({ intent: 'greeting' }, profile({ welcome: 'أهلاً بك' })).reply, 'أهلاً بك');
    assert.match(say({ intent: 'greeting' }).reply!, /أهلاً/);
  });

  it('stays out of it when an answer is silent, keeping the person’s words', async () => {
    const { deps, sent, alerts, kept } = setup({ reply: '', handover: false, summary: null, silent: true });
    assert.equal(await handlePrivateMessage(message('شو رأيك بالطقس؟'), deps), 'NO_INFO');
    assert.deepEqual([sent.length, alerts.length], [0, 0]);
    assert.deepEqual(kept, ['customer:شو رأيك بالطقس؟']);
  });

  it('chats until told to follow the paths', () => {
    assert.equal(emptyProfile().replyMode, 'chat');
    const text = composeKnowledge(profile({ about: 'نعمل حتى 6' }));
    assert.match(text, /نعمل حتى 6/);
    assert.match(text, /س: متى تفتحون؟\nج: الساعة 9 بالضبط/);
  });

  it('keeps accounts only when complete', () => {
    const tidy = tidyProfile(profile({ accounts: [account, { bank: 'x', name: '', account: '1' }] }));
    assert.deepEqual(tidy.accounts, [account]);
  });
});

describe('the paths the manager drew', () => {
  const sheet = {
    rates: [
      { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 365_000_000n, sellRate: 370_000_000n },
    ],
    remittances: [
      { destination: 'مصر', currency: 'ILS', chargeKind: 'PERCENT', chargeValue: 2n * U },
      { destination: 'الأردن', currency: 'USD', chargeKind: 'FLAT', chargeValue: 10n * U },
    ],
    usdtForCashDollars: 0,
    usdtForBankDollars: 0,
    extra: [],
  };
  const node = (over: Partial<FlowNode>): FlowNode => ({
    title: 'x',
    kind: 'text',
    text: '',
    triggers: [],
    currencies: [],
    channel: null,
    destination: null,
    accountIndex: null,
    children: [],
    ...over,
  });
  const flow = {
    prompt: 'كيف بقدر أساعدك؟',
    children: [
      node({ title: 'الحوالات', kind: 'destinations', text: 'لأي دولة؟', triggers: ['بدي أحول'] }),
      node({
        title: 'الأسعار',
        kind: 'menu',
        text: 'أي سعر؟',
        children: [
          node({ title: 'الدولار', kind: 'price', currencies: ['USD'] }),
          node({ title: 'غير متوفر', kind: 'price', currencies: ['GBP'] }),
        ],
      }),
      node({ title: 'موقعنا', kind: 'text', text: 'نحن مقابل البنك', triggers: ['وينكم'] }),
      node({ title: 'موظف', kind: 'staff' }),
    ],
  };
  const profile = (over: Partial<BotProfile> = {}) => ({ ...emptyProfile(), flow, ...over });
  const at = 1_000_000;
  /** Sends messages in turn, each from where the last left off. */
  const talk = (messages: string[], p: BotProfile = profile()) => {
    let state: FlowState | null = null;
    return messages.map((text) => {
      const step = stepFlow(text, state, p, sheet, true, at);
      if (step) state = step.state;
      return step;
    });
  };

  it('opens the main list on a hello, with the welcome above it', () => {
    const [step] = talk(['مرحبا'], profile({ welcome: 'أهلاً بك' }));
    assert.equal(step!.reply, 'أهلاً بك\n\nكيف بقدر أساعدك؟\n1. الحوالات\n2. الأسعار\n3. موقعنا\n4. موظف\n\n#. موظف');
  });

  it('walks from a list of countries, filled in itself, to the fee', () => {
    const [, list, fee] = talk(['مرحبا', '1', '1']);
    assert.equal(list!.reply, 'لأي دولة؟\n1. مصر\n2. الأردن\n\n0. رجوع   #. موظف');
    assert.match(fee!.reply, /الحوالة إلى مصر \(شيكل\): الرسوم 2%/);
    assert.match(fee!.reply, /0\. رجوع/);
  });

  it('takes Arabic digits and a name as well as a number', () => {
    assert.match(talk(['مرحبا', '٢'])[1]!.reply, /أي سعر؟/);
    assert.match(talk(['مرحبا', 'الاسعار'])[1]!.reply, /أي سعر؟/);
    assert.match(talk(['مرحبا', '1', 'الأردن'])[2]!.reply, /10 دولار/);
  });

  it('opens a choice straight from what someone writes, without an assistant', () => {
    assert.match(talk(['بدي أحول على مصر'])[0]!.reply, /لأي دولة؟/);
    assert.equal(talk(['وينكم يا شباب'])[0]!.reply, 'نحن مقابل البنك\n\n0. رجوع   #. موظف');
  });

  it('goes back a list at a time, and from an answer to the list it came from', () => {
    const [, , answer, back, up] = talk(['مرحبا', '2', '1', '0', '0']);
    assert.match(answer!.reply, /دولار مقابل شيكل/);
    assert.match(back!.reply, /أي سعر؟/);
    assert.match(up!.reply, /كيف بقدر أساعدك؟/);
  });

  it('hands to staff on # or the choice, and on an answer that has gone', () => {
    const viaHash = talk(['مرحبا', '#'])[1]!;
    assert.equal(viaHash.handover, true);
    assert.match(viaHash.reply, /رح يتواصل معك/);
    assert.equal(talk(['مرحبا', '4'])[1]!.handover, true);
    const gone = talk(['مرحبا', '2', '2'])[2]!;
    assert.equal(gone.handover, true);
    assert.equal(gone.summary, 'الأسعار ← غير متوفر');
  });

  it('hands over rather than show an empty list', () => {
    const noCountries = stepFlow('بدي أحول', null, profile(), { ...sheet, remittances: [] }, true, at)!;
    assert.equal(noCountries.handover, true);
    assert.match(noCountries.reply, /رح يتواصل معك/);
  });

  it('leaves what fits nothing to be asked about, and a number out of range too', () => {
    assert.equal(talk(['شو أخبار الطقس'])[0], null);
    assert.equal(talk(['مرحبا', '9'])[1], null);
  });

  it('forgets a place left too long', () => {
    const first = stepFlow('مرحبا', null, profile(), sheet, true, at)!;
    assert.match(stepFlow('2', first.state, profile(), sheet, true, at + 60_000)!.reply, /أي سعر؟/);
    assert.equal(stepFlow('2', first.state, profile(), sheet, true, at + FLOW_EXPIRES + 1), null);
  });

  it('is not there at all until a path is drawn', () => {
    assert.equal(stepFlow('مرحبا', null, emptyProfile(), sheet, true, at), null);
  });

  it('opens a top choice the assistant recognised, and shows the list for the rest', () => {
    assert.match(enterFlow(1, profile(), sheet, true, at)!.reply, /أي سعر؟/);
    assert.equal(enterFlow(9, profile(), sheet, true, at), null);
    assert.match(currentMenu(null, profile(), sheet, true, at)!.reply, /كيف بقدر أساعدك؟/);
  });

  it('drops unnamed choices, and lists nested too deep', () => {
    const deep = node({ title: 'a', kind: 'menu', children: [node({ title: 'b', kind: 'menu', children: [node({ title: 'c', kind: 'menu', children: [node({ title: 'd', kind: 'menu', children: [node({ title: 'e' })] })] })] })] });
    const tidy = tidyProfile(profile({ flow: { prompt: ' ', children: [deep, node({ title: ' ' })] } }));
    assert.equal(tidy.flow.children.length, 1);
    assert.equal(tidy.flow.children[0]!.children[0]!.children[0]!.children[0]!.children.length, 0);
  });

  it('walks in a real conversation, showing the list once when nothing fits', async () => {
    const walked = setup({ reply: '', handover: false, summary: null, silent: true });
    const p = profile();
    walked.deps.flows = {
      step: async (text, state, now) => stepFlow(text, state, p, sheet, true, now),
      enter: async (index, now) => enterFlow(index, p, sheet, true, now),
      menu: async (state, now) => currentMenu(state, p, sheet, true, now),
      quote: async () => null,
    };
    assert.equal(await handlePrivateMessage(message('مرحبا'), walked.deps), 'FLOW');
    assert.equal(await handlePrivateMessage(message('2'), walked.deps), 'FLOW');
    assert.equal(walked.asked.length, 0);
    assert.equal(await handlePrivateMessage(message('الطقس حلو'), walked.deps), 'FLOW');
    assert.equal(walked.asked.length, 1);
    assert.match(walked.sent.at(-1)!, /أي سعر؟/);
    assert.equal(await handlePrivateMessage(message('الجو بارد'), walked.deps), 'NO_INFO');
  });
});

describe('what a remittance costs, from what is to arrive', () => {
  const egypt: CountryPrice = {
    country: 'مصر',
    unit: 'جنيه',
    tiers: [
      { from: '1', to: '5000', cashRate: '15', bankRate: '14.5', cashFee: '10', bankFee: '5', feeKind: 'FLAT' },
      { from: '5001', to: '', cashRate: '16', bankRate: '15', cashFee: '2', bankFee: '', feeKind: 'PERCENT' },
    ],
  };
  const sheet = { rates: [], remittances: [], usdtForCashDollars: 0, usdtForBankDollars: 0, extra: [] };
  const profile = (over: Partial<BotProfile> = {}): BotProfile => ({
    ...emptyProfile(),
    countryPrices: [egypt],
    flow: {
      prompt: 'اختر',
      children: [
        { title: 'الحوالات', kind: 'countries', text: 'لأي دولة؟', triggers: [], currencies: [], channel: null, destination: null, accountIndex: null, children: [] },
      ],
    },
    ...over,
  });

  it('works back to whole shekels, by band, each way of paying', () => {
    assert.equal(
      quoteCountry(egypt, 3000n * U, null),
      'ليصل 3,000 جنيه إلى مصر:\nنقدي: 210 شيكل (المبلغ 200، الرسوم 10)\nبنكي: 212 شيكل (المبلغ 207، الرسوم 5)\nوالسعر ممكن يتغير.',
    );
  });

  it('takes a percentage fee on the band that has one, and one way of paying', () => {
    assert.equal(
      quoteCountry(egypt, 8000n * U, 'CASH'),
      'ليصل 8,000 جنيه إلى مصر:\nنقدي: 510 شيكل (المبلغ 500، الرسوم 10)\nوالسعر ممكن يتغير.',
    );
  });

  it('rounds up, so the office is never short', () => {
    assert.equal(priceFor('15', '', 'FLAT', 100n * U)!.pay, 7n * U);
    assert.equal(priceFor('15', '', 'FLAT', 150n * U)!.pay, 10n * U);
  });

  it('says nothing for a sum outside every band, or a price not filled in', () => {
    assert.equal(quoteCountry(egypt, 0n, null), null);
    assert.equal(quoteCountry({ ...egypt, tiers: [{ ...egypt.tiers[0]!, cashRate: '', bankRate: 'x' }] }, 100n * U, null), null);
  });

  it('asks the sum on the path, then answers, taking Arabic digits', () => {
    let state: FlowState | null = null;
    const go = (text: string) => {
      const step = stepFlow(text, state, profile(), sheet, true, 1000);
      if (step) state = step.state;
      return step;
    };
    go('مرحبا');
    assert.match(go('1')!.reply, /لأي دولة؟\n1\. مصر/);
    assert.match(go('1')!.reply, /كم بدك يوصل للمستفيد في مصر؟ اكتب المبلغ بـجنيه/);
    assert.match(go('٣٠٠٠')!.reply, /نقدي: 210 شيكل/);
  });

  it('answers from one sentence, and asks only for what is missing', () => {
    const full = quoteStep({ country: 'مصر', delivered: '3000', channel: 'BANK', wantsStaff: false, summary: null }, null, profile(), sheet, true, 1000)!;
    assert.match(full.reply, /بنكي: 212 شيكل/);
    assert.doesNotMatch(full.reply, /نقدي/);
    const noSum = quoteStep({ country: 'مصر', delivered: null, channel: null, wantsStaff: false, summary: null }, null, profile(), sheet, true, 1000)!;
    assert.equal(noSum.state!.quote, 'مصر');
    assert.equal(quoteStep({ country: 'تركيا', delivered: '1', channel: null, wantsStaff: false, summary: null }, null, profile(), sheet, true, 1000), null);
  });

  it('works without a menu drawn, for the sum it asked for', () => {
    const noMenu = profile({ flow: { prompt: '', children: [] } });
    const asked = quoteStep({ country: 'مصر', delivered: null, channel: null, wantsStaff: false, summary: null }, null, noMenu, sheet, true, 1000)!;
    assert.match(stepFlow('3000', asked.state, noMenu, sheet, true, 1000)!.reply, /نقدي: 210 شيكل/);
  });

  it('hands over a sum no band covers, and a deal someone wants done', () => {
    assert.equal(quoteStep({ country: 'مصر', delivered: '0.5', channel: null, wantsStaff: false, summary: null }, null, profile(), sheet, true, 1000)!.handover, true);
    const deal = quoteStep({ country: 'مصر', delivered: '3000', channel: 'CASH', wantsStaff: true, summary: 'يريد إرسال حوالة' }, null, profile(), sheet, true, 1000)!;
    assert.equal(deal.handover, true);
    assert.equal(deal.summary, 'يريد إرسال حوالة');
    assert.match(deal.reply, /رح يتواصل معك/);
  });
});

describe('the lines the manager drew', () => {
  const profile = (over: Partial<BotProfile>): BotProfile => ({ ...emptyProfile(), ...over });
  const answer = { reply: 'نعطيك خصم ممتاز', handover: false, summary: null };

  it('never sends a reply with a blocked word, and hands the person over', async () => {
    const { deps, sent, alerts, raised } = setup(answer, 100, profile({ blockedWords: ['خصم'] }));
    assert.equal(await handlePrivateMessage(message('فيه خصم؟'), deps), 'HELD_BACK');
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0]!, /خصم/);
    assert.match(sent[0]!, /موظف/);
    assert.equal(alerts.length, 1);
    assert.equal(raised.length, 1);
  });

  it('finds a blocked word however it is spelled', () => {
    assert.equal(firstMatch('هذا العرض الخاصّ', ['الخاص']), 'الخاص');
    assert.equal(firstMatch('تخفيضة كبيرة', ['تخفيضه']), 'تخفيضه');
    assert.equal(firstMatch('السلام عليكم', ['خصم']), null);
    assert.equal(firstMatch('شيء', []), null);
  });

  it('sends a topic for staff straight to them, without asking the assistant', async () => {
    const { deps, sent, asked, alerts } = setup(answer, 100, profile({ humanTopics: ['شكوى'] }));
    assert.equal(await handlePrivateMessage(message('عندي شكوى على موظف'), deps), 'TO_STAFF');
    assert.equal(asked.length, 0);
    assert.match(sent[0]!, /موظف/);
    assert.match(alerts[0]!, /عندي شكوى/);
  });

  it('lets through what crosses none of them', async () => {
    const { deps, sent } = setup({ reply: 'الدولار 3.7', handover: false, summary: null }, 100, profile({ blockedWords: ['خصم'], humanTopics: ['شكوى'] }));
    assert.equal(await handlePrivateMessage(message('كم الدولار؟'), deps), 'ANSWERED');
    assert.deepEqual(sent, ['الدولار 3.7']);
  });

  it('puts the office’s rules first, and says nothing when there are none', () => {
    assert.match(composeRules(profile({ rules: ['لا تعطِ خصومات'] })), /come before everything else[\s\S]*1\. لا تعطِ خصومات/);
    assert.equal(composeRules(emptyProfile()), '');
  });

  it('keeps lists clean', () => {
    const tidy = tidyProfile(profile({ blockedWords: [' خصم ', 'خصم', ''], rules: ['  ', 'قاعدة'], humanTopics: [] }));
    assert.deepEqual([tidy.blockedWords, tidy.rules], [['خصم'], ['قاعدة']]);
  });
});

describe('passing on what reaches the number', () => {
  const run = async (incoming: IncomingText, over: Partial<ForwardDeps> = {}) => {
    const out: string[] = [];
    const outcome = await forwardToGroup(incoming, {
      group: async () => 'g@g.us',
      media: async () => null,
      sendText: async (group, text) => void out.push(`${group} text: ${text}`),
      sendMedia: async (group, media, caption) =>
        void out.push(`${group} ${media.kind} ${media.mimeType}: ${caption}`),
      ...over,
    });
    return { outcome, out };
  };
  const from = '📩 *من:* +970599000000';
  const file = (kind: ForwardedMedia['kind'], mimeType: string) => async () =>
    ({ kind, data: Buffer.from('x'), mimeType }) as ForwardedMedia;

  it('leaves words on their own where they are', async () => {
    const { outcome, out } = await run(message('وصلتني حوالة'));
    assert.equal(outcome, 'WORDS_ONLY');
    assert.deepEqual(out, []);
  });

  it('sends a picture, video or file on with who sent it as the caption', async () => {
    for (const [kind, type] of [['image', 'image/png'], ['video', 'video/mp4'], ['document', 'application/pdf']] as const) {
      const { outcome, out } = await run(message('الإيصال'), { media: file(kind, type) });
      assert.equal(outcome, 'SENT_MEDIA');
      assert.deepEqual(out, [`g@g.us ${kind} ${type}: ${from}\nالإيصال`]);
    }
  });

  it('says who sent a sound just before it, since it cannot carry a caption', async () => {
    const { out } = await run(message(''), { media: file('audio', 'audio/ogg') });
    assert.deepEqual(out, [`g@g.us text: ${from}`, `g@g.us audio audio/ogg: ${from}`]);
  });

  it('says so when a file cannot be fetched', async () => {
    const failed = await run(message(''), {
      media: async () => {
        throw new Error('expired');
      },
    });
    assert.equal(failed.outcome, 'SENT_NOTE');
    assert.match(failed.out[0]!, /افتح المحادثة/);
  });

  it('does nothing until a group is chosen', async () => {
    const { outcome, out } = await run(message('سلام'), {
      group: async () => '',
      media: file('image', 'image/png'),
    });
    assert.equal(outcome, 'NO_GROUP');
    assert.deepEqual(out, []);
  });
});

describe('working beside the staff', () => {
  const photo = () => ({ ...message(''), media: true }) as IncomingText;

  it('keeps out of a conversation a person has taken, but keeps what was said', async () => {
    const { deps, sent, asked, kept, paused } = setup();
    paused.on = true;
    assert.equal(await handlePrivateMessage(message('وينكم؟'), deps), 'PAUSED');
    assert.deepEqual([sent.length, asked.length], [0, 0]);
    assert.deepEqual(kept, ['customer:وينكم؟']);
  });

  it('keeps both sides of what is answered', async () => {
    const { deps, kept } = setup();
    await handlePrivateMessage(message('كم الدولار؟'), deps);
    assert.deepEqual(kept, ['customer:كم الدولار؟', 'bot:الدولار 3.15']);
  });

  it('keeps a request with the group’s alert, once for a while', async () => {
    const { deps, raised } = setup({ reply: 'تمام', handover: true, summary: 'يريد بيع 1000 دولار' });
    await handlePrivateMessage(message('بدي أبيع'), deps);
    await handlePrivateMessage(message('ردوا علي'), deps);
    assert.deepEqual(raised, ['يريد بيع 1000 دولار']);
  });

  it('says it cannot read a picture, once for a run of them, at no cost', async () => {
    const { deps, sent, asked, pass } = setup();
    assert.equal(await handlePrivateMessage(photo(), deps), 'NOT_TEXT');
    await handlePrivateMessage(photo(), deps);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /اكتب سؤالك/);
    assert.equal(asked.length, 0);
    pass(11 * 60 * 1000);
    await handlePrivateMessage(photo(), deps);
    assert.equal(sent.length, 2);
  });

  it('knows when the office is open, on the office’s clock', () => {
    const hours = { enabled: true, open: '09:00', close: '18:00', closedDays: [5] };
    // Noon UTC on a Monday in November is 14:00 in Palestine.
    const monday = new Date('2026-11-09T12:00:00Z');
    assert.equal(officeOpen(hours, monday), true);
    assert.equal(officeOpen(hours, new Date('2026-11-09T17:00:00Z')), false);
    assert.equal(officeOpen(hours, new Date('2026-11-09T05:00:00Z')), false);
    assert.equal(officeOpen({ ...hours, closedDays: [1] }, monday), false);
    assert.equal(officeOpen({ ...hours, enabled: false }, new Date('2026-11-09T23:00:00Z')), true);
  });
});

describe('a sum worked out for a customer', () => {
  const rates = [
    { baseCode: 'USD', quoteCode: 'ILS', channel: 'CASH', buyRate: 365_000_000n, sellRate: 370_000_000n },
    { baseCode: 'USD', quoteCode: 'ILS', channel: 'BROKER', buyRate: 362_000_000n, sellRate: 0n },
  ];
  const ask = (over = {}) => ({
    side: 'customer_sells' as const,
    currency: 'USD',
    amount: '1000',
    other_currency: 'ILS',
    channel: null,
    ...over,
  });

  it('uses the buying price when they sell, each way of paying on its own line', () => {
    assert.deepEqual(calculationLines(ask(), rates), [
      '1,000 دولار = 3,650 شيكل (نقدي)',
      '1,000 دولار = 3,620 شيكل (تحويل بنكي)',
    ]);
  });

  it('uses the selling price when they buy, and the way they said', () => {
    assert.deepEqual(calculationLines(ask({ side: 'customer_buys', channel: 'CASH' }), rates), [
      '1,000 دولار = 3,700 شيكل (نقدي)',
    ]);
  });

  it('skips a side with no price, a hidden pair, and an amount that is not one', () => {
    assert.deepEqual(calculationLines(ask({ side: 'customer_buys', channel: 'BANK' }), rates), []);
    assert.deepEqual(calculationLines(ask({ currency: 'JOD' }), rates), []);
    assert.deepEqual(calculationLines(ask({ amount: 'كثير' }), rates), []);
    assert.deepEqual(calculationLines(ask({ amount: '0' }), rates), []);
  });

  it('takes Arabic digits and thousands', () => {
    assert.equal(calculationLines(ask({ amount: '٢,٠٠٠', channel: 'CASH' }), rates)[0], '2,000 دولار = 7,300 شيكل (نقدي)');
  });
});

describe('what the private number still needs', () => {
  const ready = { linked: true, group: 'g@g.us', switchedOn: true, key: 'k' };
  it('is nothing when it is all set up', () => {
    assert.deepEqual(gapsOf(ready), []);
  });
  it('names each thing missing, in the order they are done', () => {
    assert.deepEqual(gapsOf({ linked: false, group: '', switchedOn: false, key: '' }), [
      'NOT_LINKED',
      'NO_GROUP',
      'SWITCHED_OFF',
      'NO_KEY',
    ]);
    assert.deepEqual(gapsOf({ ...ready, switchedOn: false }), ['SWITCHED_OFF']);
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

  it('finds a group by part of its name, however it is spelled', () => {
    const groups = [{ name: 'مجموعة الأسعار' }, { name: 'طلبات العملاء' }, { name: 'Bank Team' }];
    assert.deepEqual(groupsMatching(groups, 'اسعار').map((g) => g.name), ['مجموعة الأسعار']);
    assert.deepEqual(groupsMatching(groups, 'bank').map((g) => g.name), ['Bank Team']);
    assert.equal(groupsMatching(groups, '  ').length, 3);
    assert.equal(groupsMatching(groups, 'غير موجودة').length, 0);
  });

  it('lists a group WhatsApp gives no subject or members for', () => {
    assert.deepEqual(groupEntry({ id: 'g@g.us' }, 'private'), {
      id: 'g@g.us',
      name: 'مجموعة بدون اسم',
      size: 0,
      account: 'private',
    });
    assert.equal(groupEntry({ id: 'g', subject: ' المكتب ', participants: [1, 2] }, 'main').name, 'المكتب');
  });

  it('writes from the private number only to a group it is in, and only when no other is', () => {
    const both = { main: new Set(['g@g.us']), private: new Set(['g@g.us', 'p@g.us']) };
    assert.equal(chooseAccount('g@g.us', ['main', 'private'], both), 'main');
    assert.equal(chooseAccount('p@g.us', ['main', 'private'], both), 'private');
    assert.equal(chooseAccount('other@g.us', ['main', 'private'], both), 'main');
    assert.equal(chooseAccount('other@g.us', ['private'], both), null);
    assert.equal(chooseAccount('person@s.whatsapp.net', ['private'], both), null);
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
    assert.match(sheet, /- الدولار مقابل الشيكل، نقداً: نشتري بـ 3\.1، نبيع بـ 3\.15 الشيكل/);
    assert.match(sheet, /- الدولار مقابل الشيكل، بتحويل بنكي: نشتري بـ 3\.08 الشيكل/);
  });

  it('says remittance fees, and the USDT percentage only when one is set', () => {
    assert.match(sheet, /إلى مصر بعملة الشيكل: الرسوم 2%/);
    assert.match(sheet, /إلى الأردن بعملة الدولار: الرسوم 10 الدولار/);
    assert.match(sheet, /دولار نقدي: نخصم 1%/);
    assert.doesNotMatch(sheet, /بتحويل بنكي: نخصم/);
  });

  it('says so when nothing is published', () => {
    const empty = composePriceSheet({ rates: [], remittances: [], usdtForCashDollars: 0, usdtForBankDollars: 0 });
    assert.match(empty, /لا توجد أسعار منشورة/);
  });
});
