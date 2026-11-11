import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyProfile, parseProfile, tidyProfile } from '../src/modules/whatsapp/bot-profile.ts';
import { groupPlan } from '../src/modules/whatsapp/group-routes.ts';
import { forwardToGroup } from '../src/modules/whatsapp/private-bot.service.ts';
import { DEFAULT_NOTICE_WORDS, westernNotice } from '../src/modules/whatsapp/western-notices.ts';
import type { IncomingText } from '../src/modules/whatsapp/whatsapp.service.ts';

const lists = { senders: ['+1 (800) 325-6000', '0599 123 456'], keywords: DEFAULT_NOTICE_WORDS };
const from = (text: string, senderPhone: string | null, chat = 'someone@lid') => ({ text, senderPhone, chat });

describe('a Western Union notice', () => {
  it('is whatever a listed sender writes, however the number was typed', () => {
    assert.equal(westernNotice(from('Payment received', '18003256000@s.whatsapp.net'), lists), 'SENDER');
    assert.equal(westernNotice(from('وصلت', '970599123456@s.whatsapp.net'), lists), 'SENDER');
    assert.equal(westernNotice(from('', null, '972599123456@s.whatsapp.net'), lists), 'SENDER');
  });

  it('is a message with one of the words, from anyone', () => {
    assert.equal(westernNotice(from('Your MTCN is 1234567890', '970591111111'), lists), 'WORDS');
    assert.equal(westernNotice(from('western union: money ready', null), lists), 'WORDS');
    assert.equal(westernNotice(from('بدي ابعت ويسترن', '970591111111'), lists), 'WORDS');
  });

  it('is nothing else, and a hidden number is never taken for a sender', () => {
    assert.equal(westernNotice(from('كم سعر الدولار؟', '970591111111'), lists), null);
    assert.equal(westernNotice(from('مرحبا', null, '18003256000@lid'), lists), null);
    assert.equal(westernNotice(from('MTCN', '970591111111'), { senders: [], keywords: [] }), null);
    assert.equal(westernNotice(from('hi', '123'), { senders: ['123'], keywords: [] }), null);
  });

  it('starts with the usual words and no senders, and keeps the lists tidy', () => {
    assert.deepEqual(emptyProfile().westernNotices, { senders: [], keywords: DEFAULT_NOTICE_WORDS });
    assert.deepEqual(parseProfile('{"westernNotices":{"keywords":[]}}').westernNotices.keywords, []);
    const tidy = tidyProfile({ ...emptyProfile(), westernNotices: { senders: [' 0599 ', '', '0599'], keywords: [' MTCN '] } });
    assert.deepEqual(tidy.westernNotices, { senders: ['0599'], keywords: ['MTCN'] });
  });

  it('goes to its group only when one is chosen', () => {
    assert.deepEqual(groupPlan({}, 'main@g.us').flatMap((g) => g.hears).includes('إشعارات الويسترن'), false);
    const plan = groupPlan({ WESTERN_NOTICES: { id: 'wu@g.us', name: '' } }, 'main@g.us');
    assert.deepEqual(plan.find((g) => g.id === 'wu@g.us')?.hears, ['إشعارات الويسترن']);
  });
});

describe('passing a notice on', () => {
  const incoming = (text: string) =>
    ({ chat: 'x@lid', text, senderPhone: '970599123456@s.whatsapp.net', message: {}, account: 'private' }) as unknown as IncomingText;
  const deps = (group = 'wu@g.us') => {
    const sent: string[] = [];
    return {
      sent,
      deps: {
        group: async () => group,
        media: async () => null,
        sendText: async (_g: string, text: string) => void sent.push(text),
        sendMedia: async () => undefined,
      },
    };
  };

  it('sends its words, with who sent it', async () => {
    const { sent, deps: d } = deps();
    assert.equal(await forwardToGroup(incoming('MTCN 123'), d, { words: true }), 'SENT_WORDS');
    assert.deepEqual(sent, ['📩 *من:* +970599123456\nMTCN 123']);
  });

  it('leaves words alone for the files group, as before', async () => {
    const { sent, deps: d } = deps();
    assert.equal(await forwardToGroup(incoming('مرحبا'), d), 'WORDS_ONLY');
    assert.equal(sent.length, 0);
    assert.equal(await forwardToGroup(incoming('MTCN'), deps('').deps, { words: true }), 'NO_GROUP');
  });
});
