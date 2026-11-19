import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markedBy, markOf } from '../src/modules/bank/group-marks.ts';

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
