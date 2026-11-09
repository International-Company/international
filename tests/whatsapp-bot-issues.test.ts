// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detailOf, wordingOf } from '../src/modules/whatsapp/bot-issues.ts';

describe('a bot problem, as the manager reads it', () => {
  it('says a known failure in the office’s words, with what to do', () => {
    const wording = wordingOf('Could not announce a deal', 'WhatsApp is not linked');
    assert.equal(wording.title, 'لم تُرسل عملية إلى المجموعة');
    assert.match(wording.action, /مرتبط/);
    assert.equal(wording.critical, true);
  });

  it('names running out of credit whichever failure it caused', () => {
    const detail = '400 Your credit balance is too low to access the Anthropic API';
    const answer = wordingOf('Could not get an answer for a customer', detail);
    const photo = wordingOf('Could not read a withdrawal photo', detail);
    assert.equal(answer.key, 'credit');
    assert.equal(photo.key, 'credit');
    assert.match(answer.title, /رصيد/);
  });

  it('still shows a failure nobody has worded', () => {
    assert.equal(wordingOf('Something new', '').title, 'Something new');
  });

  it('keeps the useful part of the context, short, and no stack', () => {
    const detail = detailOf({
      reference: 'TXN-1',
      status: 400,
      error: new Error('boom'),
    });
    assert.equal(detail, 'TXN-1 — status: 400 — boom');
    assert.equal(detailOf(undefined), '');
    assert.equal(detailOf({ reason: 'x'.repeat(900) }).length, 400);
    assert.doesNotMatch(detailOf({ error: new Error('boom') }), /at /);
  });
});
