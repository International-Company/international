import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markedBy, markOf, wordsOf } from '../src/modules/bank/group-marks.ts';

describe('the marks put on a transfer in the groups', () => {
  it('reads the red heart as passed on, with or without its colour selector', () => {
    assert.equal(markOf('❤️'), 'forwarded');
    assert.equal(markOf('❤'), 'forwarded');
  });

  it('reads the thumb as sent, whatever its skin tone', () => {
    assert.equal(markOf('👍'), 'done');
    assert.equal(markOf('👍🏻'), 'done');
    assert.equal(markOf('👍🏿'), 'done');
  });

  it('reads anything else as nothing', () => {
    for (const other of ['', '😂', '🙏', '💚', '🧡', '👎', '✅', '❤️❤️']) {
      assert.equal(markOf(other), null, other);
    }
  });

  it('names the mark by who put it', () => {
    assert.equal(markedBy('أبو محمد', '970599000000'), '❤️ أبو محمد');
    assert.equal(markedBy(null, '970599000000'), '❤️ +970599000000');
    assert.equal(markedBy('  ', null), '❤️');
  });
});

describe('a transfer forwarded by hand, found by its words', () => {
  it('reads two copies of a message alike, whatever marks and spaces the phone added', () => {
    const original = 'الاسم: محمد\nالحساب: 0599000000\nالمبلغ: 300';
    const forwarded = '‏الاسم:  محمد \r\nالحساب: 0599000000\nالمبلغ: 300 ';
    assert.equal(wordsOf(forwarded), wordsOf(original));
  });

  it('keeps two different transfers apart', () => {
    assert.notEqual(wordsOf('الحساب: 0599000000 المبلغ: 300'), wordsOf('الحساب: 0599000000 المبلغ: 350'));
  });
});
