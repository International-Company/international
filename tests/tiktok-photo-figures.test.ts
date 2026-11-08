import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { photoFigure } from '../src/modules/tiktok/photo-figures.ts';

describe('a figure read off a withdrawal photo', () => {
  it('reaches the field as plain digits', () => {
    assert.equal(photoFigure('5149.44'), '5149.44');
    assert.equal(photoFigure('100.00'), '100.00');
    assert.equal(photoFigure('5,149.44'), '5149.44');
    assert.equal(photoFigure('٥١٤٩'), '5149');
  });

  it('is dropped when it is not a sum greater than zero', () => {
    for (const value of [null, undefined, '', '0', '0.00', 'EGP 5149', '5149.444', '-5', '12,34']) {
      assert.equal(photoFigure(value), null, String(value));
    }
  });
});
