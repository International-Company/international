// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { categoriesOf } from '../src/modules/whatsapp/group-routes.ts';
import { composeGroupReconciliation } from '../src/modules/whatsapp/reconcile-message.ts';
import { handleReconcile, type ReconcileDeps } from '../src/modules/whatsapp/reconcile.service.ts';
import type { IncomingText } from '../src/modules/whatsapp/whatsapp.service.ts';

const U = 100_000_000n;
const stamp = { day: '2026-11-07', asOf: '15:00' };

describe('each group’s reconciliation', () => {
  it('tells the bank group what the office owes by transfer, by kind and by account', () => {
    assert.equal(
      composeGroupReconciliation({
        ...stamp,
        bank: [
          { kind: 'EXCHANGE', currency: 'ILS', amount: 1200n * U, channel: 'بنك فلسطين' },
          { kind: 'USDT', currency: 'ILS', amount: 3700n * U, channel: 'جوال باي' },
          { kind: 'EXCHANGE', currency: 'ILS', amount: 800n * U, channel: 'جوال باي' },
          { kind: 'USDT', currency: 'ILS', amount: 300n * U, channel: null },
        ],
      }),
      [
        '📋 *مطابقة المستحق البنكي*',
        '2026-11-07 — حتى الساعة 15:00',
        '',
        '▫️ الصرافة: 2 عمليات — 2,000 شيكل',
        '▫️ USDT: 2 عمليات — 4,000 شيكل',
        '',
        'حسب الحساب:',
        '• بنك فلسطين: 1,200 شيكل',
        '• جوال باي: 4,500 شيكل',
        '• بلا حساب محدد: 300 شيكل',
        '',
        '*المجموع: 6,000 شيكل*',
      ].join('\n'),
    );
  });

  it('lists the remittances sent, then their count and total per unit', () => {
    assert.equal(
      composeGroupReconciliation({
        ...stamp,
        remittances: [
          { phone: '01012345678', amount: 3000n * U, unit: 'جنيه' },
          { phone: '01098765432', amount: 1500n * U, unit: 'جنيه' },
          { phone: null, amount: 400n * U, unit: 'ILS' },
        ],
      }),
      [
        '📋 *مطابقة الحوالات الصادرة*',
        '2026-11-07 — حتى الساعة 15:00',
        '',
        '1. 01012345678 — 3,000 جنيه',
        '2. 01098765432 — 1,500 جنيه',
        '3. 400 شيكل',
        '',
        'عدد الحوالات: 3',
        '*المجموع: 4,500 جنيه + 400 شيكل*',
      ].join('\n'),
    );
  });

  it('tells the TikTok group the shekels first, then the dollars and pounds', () => {
    const text = composeGroupReconciliation({
      ...stamp,
      tiktok: [
        { amount: 100n * U, currency: 'USD', payoutAmount: 255n * U, egpAmount: 4900n * U },
        { amount: 50n * U, currency: 'USD', payoutAmount: 127n * U, egpAmount: null },
      ],
    });
    assert.equal(
      text,
      [
        '📋 *مطابقة تيكتوك*',
        '2026-11-07 — حتى الساعة 15:00',
        '',
        'عدد السحوبات: 2',
        'مجموع الشيكل: *382 شيكل*',
        'مجموع الدولار: *150 دولار*',
        'مجموع الجنيه: *4,900 جنيه*',
        '(1 سحب بلا مبلغ بالجنيه)',
      ].join('\n'),
    );
  });

  it('says so when a kind had nothing today', () => {
    const text = composeGroupReconciliation({ ...stamp, bank: [], remittances: [] })!;
    assert.match(text, /^📋 \*مطابقة اليوم\*/);
    assert.match(text, /🏦 \*المستحق البنكي\*\nلا مستحقات بنكية اليوم/);
    assert.match(text, /💸 \*الحوالات الصادرة\*\nلا حوالات صادرة اليوم/);
  });

  it('is nothing for a group sent none of these kinds', () => {
    assert.equal(composeGroupReconciliation(stamp), null);
  });
});

describe('the kinds a group is sent', () => {
  const routes = {
    REMITTANCE: { id: 'rem@g.us', name: 'الحوالات' },
    TIKTOK: { id: 'tt@g.us', name: 'تيكتوك' },
    TIKTOK_NAME: { id: 'names@g.us', name: 'الأسماء' },
  };
  it('follows the routes, and what falls back to the main group', () => {
    assert.deepEqual(categoriesOf('rem@g.us', routes, 'main@g.us'), ['REMITTANCE']);
    assert.deepEqual(categoriesOf('tt@g.us', routes, 'main@g.us'), ['TIKTOK']);
    assert.deepEqual(categoriesOf('names@g.us', routes, 'main@g.us'), ['TIKTOK_NAME']);
    assert.deepEqual(categoriesOf('main@g.us', routes, 'main@g.us'), [
      'EXCHANGE',
      'USDT',
      'USDT_SALE',
    ]);
    assert.deepEqual(categoriesOf('other@g.us', routes, 'main@g.us'), []);
  });
});

describe('#مطابقة', () => {
  const incoming = (chat: string, text: string) =>
    ({
      chat,
      text,
      sender: null,
      senderPhone: null,
      message: {},
      account: 'main',
    }) as unknown as IncomingText;

  const run = async (chat: string, text: string) => {
    const sent: string[] = [];
    const asked: string[] = [];
    const deps: ReconcileDeps = {
      categories: async (group) =>
        group === 'bank@g.us'
          ? ['EXCHANGE', 'USDT']
          : group === 'names@g.us'
            ? ['TIKTOK_NAME']
            : [],
      bank: async (_now, kinds) => {
        asked.push(`bank:${kinds.join(',')}`);
        return [{ kind: 'USDT', currency: 'ILS', amount: 100n * U, channel: 'جوال باي' }];
      },
      remittances: async () => {
        asked.push('remittances');
        return [];
      },
      tiktok: async () => {
        asked.push('tiktok');
        return [];
      },
      reply: async (_m, body) => {
        sent.push(body);
      },
      now: () => new Date(2026, 10, 7, 15, 0),
    };
    return { outcome: await handleReconcile(incoming(chat, text), deps), sent, asked };
  };

  it('answers a group with its own part, reading nothing else', async () => {
    const { outcome, sent, asked } = await run('bank@g.us', ' #مطابقة ');
    assert.equal(outcome, 'SENT');
    assert.deepEqual(asked, ['bank:EXCHANGE,USDT']);
    assert.match(sent[0]!, /مطابقة المستحق البنكي/);
  });

  it('ignores a group sent none of these, words after the code, or other text', async () => {
    assert.equal((await run('names@g.us', '#مطابقة')).outcome, 'IGNORED');
    assert.equal((await run('bank@g.us', '#مطابقة أحمد')).outcome, 'IGNORED');
    assert.equal((await run('bank@g.us', 'مطابقة')).outcome, 'IGNORED');
  });
});
