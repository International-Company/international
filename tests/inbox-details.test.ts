// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mediaMark } from '../src/modules/whatsapp/bot-store.ts';
import { mediaKindOf } from '../src/modules/whatsapp/chat-images.ts';
import { shownName } from '../src/modules/whatsapp/chat-names.ts';
import { quoteOf, quotedStanzaId } from '../src/modules/whatsapp/wa-quote.ts';

describe('the name a conversation is shown under', () => {
  const records = new Map([['599123456', 'أحمد يوسف']]);

  it('is the office’s record for the number, however it is written', () => {
    assert.equal(shownName('970599123456', 'Ahmad 📱', records), 'أحمد يوسف');
    assert.equal(shownName('972599123456', null, records), 'أحمد يوسف');
  });

  it('is the WhatsApp name when the office has no record', () => {
    assert.equal(shownName('970598000111', '  Sami  ', records), 'Sami');
    assert.equal(shownName(null, null, records), null);
  });
});

describe('a file in a conversation', () => {
  it('is told apart by its type', () => {
    assert.equal(mediaKindOf('image/jpeg'), 'image');
    assert.equal(mediaKindOf('audio/ogg; codecs=opus'), 'audio');
    assert.equal(mediaKindOf('video/mp4'), 'video');
    assert.equal(mediaKindOf('application/pdf'), 'document');
  });

  it('stands in the list for a message without words', () => {
    assert.equal(mediaMark('audio'), '🎤');
    assert.equal(mediaMark('document'), '📄');
    // Kept before the kind was: every file then was a photo.
    assert.equal(mediaMark(null, 'some-id'), '📷');
    assert.equal(mediaMark(null, null), '');
  });
});

describe('answering one message by quoting it', () => {
  it('reads which message a customer’s answer quotes', () => {
    const answer = {
      key: { remoteJid: 'x@s.whatsapp.net', id: 'B' },
      message: { extendedTextMessage: { text: 'تمام', contextInfo: { stanzaId: 'A' } } },
    };
    assert.equal(quotedStanzaId(answer as never), 'A');
    assert.equal(quotedStanzaId({ key: {}, message: { conversation: 'مرحبا' } } as never), null);
  });

  it('rebuilds a kept message for WhatsApp to quote', () => {
    const quoted = quoteOf('x@s.whatsapp.net', 'A', false, 'كم السعر؟');
    assert.deepEqual(quoted.key, { remoteJid: 'x@s.whatsapp.net', fromMe: false, id: 'A' });
    assert.equal(quoted.message?.conversation, 'كم السعر؟');
  });
});
