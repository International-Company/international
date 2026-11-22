import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sentWords } from '../src/modules/whatsapp/sent-words.ts';

/**
 * The answer under a sent transfer in the transfers group: the number it went
 * to first, so whoever reads the group sees which one without opening it.
 */
describe('the answer under a sent transfer', () => {
  it('starts with the number it went to', () => {
    assert.equal(sentWords(' 0599000111 '), '0599000111\n✅ تم التحويل');
  });

  it('is the words alone when there is no number', () => {
    assert.equal(sentWords(null), '✅ تم التحويل');
    assert.equal(sentWords('  '), '✅ تم التحويل');
  });
});
