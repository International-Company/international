// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  forwardTargets,
  parseForwardRules,
  ruleMatches,
  type ForwardRule,
} from '../src/modules/whatsapp/group-forward.ts';
import { forwardGroupMessage } from '../src/modules/whatsapp/group-forward.service.ts';
import type { IncomingText } from '../src/modules/whatsapp/whatsapp.service.ts';

const rule = (patch: Partial<ForwardRule> = {}): ForwardRule => ({
  id: 'r1',
  enabled: true,
  from: { id: 'a@g.us', name: 'أ' },
  to: { id: 'b@g.us', name: 'ب' },
  words: '',
  senders: '',
  kind: 'ALL',
  ...patch,
});

const message = (patch: Partial<Parameters<typeof ruleMatches>[1]> = {}) => ({
  chat: 'a@g.us',
  text: 'حوالة بنكية 300 شيكل',
  caption: false,
  senderPhone: '972599123456@s.whatsapp.net',
  ...patch,
});

describe('a rule passing messages between groups', () => {
  it('passes everything from its group when it has no condition', () => {
    assert.equal(ruleMatches(rule(), message()), true);
    assert.equal(ruleMatches(rule(), message({ chat: 'c@g.us' })), false);
  });

  it('passes nothing when switched off', () => {
    assert.equal(ruleMatches(rule({ enabled: false }), message()), false);
  });

  it('needs one of its words, however the hamza or taa marbuta is written', () => {
    const words = rule({ words: 'تحويل، حواله\nبنك' });
    assert.equal(ruleMatches(words, message()), true);
    assert.equal(ruleMatches(words, message({ text: 'مرحبا' })), false);
  });

  it('needs one of its numbers, written with or without the country code', () => {
    const senders = rule({ senders: '0599123456, 0598000000' });
    assert.equal(ruleMatches(senders, message()), true);
    assert.equal(ruleMatches(senders, message({ senderPhone: '972591111111' })), false);
    assert.equal(ruleMatches(senders, message({ senderPhone: null })), false);
  });

  it('reads Arabic digits in a number', () => {
    assert.equal(ruleMatches(rule({ senders: '٠٥٩٩١٢٣٤٥٦' }), message()), true);
  });

  it('keeps to typed text, or to photo captions, when asked', () => {
    assert.equal(ruleMatches(rule({ kind: 'TEXT' }), message({ caption: true })), false);
    assert.equal(ruleMatches(rule({ kind: 'CAPTION' }), message()), false);
    assert.equal(ruleMatches(rule({ kind: 'CAPTION' }), message({ caption: true })), true);
  });

  it('sends to each group once, however many rules send it there', () => {
    const rules = [
      rule(),
      rule({ id: 'r2', words: 'بنك' }),
      rule({ id: 'r3', to: { id: 'c@g.us', name: '' } }),
    ];
    assert.deepEqual(forwardTargets(rules, message()), ['b@g.us', 'c@g.us']);
  });

  it('drops a stored rule that reads and writes the same group, or has none', () => {
    const raw = JSON.stringify([
      rule(),
      rule({ id: 'x', to: { id: 'a@g.us', name: '' } }),
      { id: 'y', from: { id: '' } },
    ]);
    assert.deepEqual(
      parseForwardRules(raw).map((entry) => entry.id),
      ['r1'],
    );
    assert.deepEqual(parseForwardRules('not json'), []);
  });
});

const incoming = (patch: Partial<IncomingText> = {}): IncomingText =>
  ({
    chat: 'a@g.us',
    text: 'تحويل 300',
    sender: '972599123456@s.whatsapp.net',
    senderPhone: '972599123456@s.whatsapp.net',
    message: { key: { fromMe: false } },
    account: 'main',
    ...patch,
  }) as IncomingText;

const deps = (rules: ForwardRule[], own = false) => {
  const sent: [string, string][] = [];
  return {
    sent,
    deps: {
      rules: async () => rules,
      phoneOf: async () => null,
      ownNumber: () => own,
      send: async (group: string, text: string) => {
        sent.push([group, text]);
      },
    },
  };
};

describe('passing a group message on', () => {
  it('writes it to the other group as it was written', async () => {
    const { sent, deps: d } = deps([rule()]);
    await forwardGroupMessage(incoming(), d);
    assert.deepEqual(sent, [['b@g.us', 'تحويل 300']]);
  });

  it('passes on the words under a photo', async () => {
    const { sent, deps: d } = deps([rule()]);
    await forwardGroupMessage(incoming({ text: '', caption: 'صورة تحويل' }), d);
    assert.deepEqual(sent, [['b@g.us', 'صورة تحويل']]);
  });

  it('never passes on what the office’s own numbers wrote', async () => {
    const own = deps([rule()], true);
    await forwardGroupMessage(incoming(), own.deps);
    const typed = deps([rule()]);
    await forwardGroupMessage(
      incoming({ message: { key: { fromMe: true } } } as never),
      typed.deps,
    );
    assert.deepEqual([...own.sent, ...typed.sent], []);
  });

  it('reads nothing the private number hears', async () => {
    const { sent, deps: d } = deps([rule()]);
    await forwardGroupMessage(incoming({ account: 'private' }), d);
    assert.deepEqual(sent, []);
  });
});
