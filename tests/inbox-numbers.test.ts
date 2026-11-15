import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { candidateNumbers } from '../src/modules/whatsapp/inbox-numbers.ts';

describe('a number typed to start a conversation', () => {
  it('offers both country codes for a local mobile number', () => {
    assert.deepEqual(candidateNumbers('0599123456'), ['970599123456', '972599123456']);
    assert.deepEqual(candidateNumbers('599123456'), ['970599123456', '972599123456']);
    assert.deepEqual(candidateNumbers('059-912 3456'), ['970599123456', '972599123456']);
  });

  it('takes a number written with its country code as it is', () => {
    assert.deepEqual(candidateNumbers('+970 599 123 456'), ['970599123456']);
    assert.deepEqual(candidateNumbers('00972599123456'), ['972599123456']);
    assert.deepEqual(candidateNumbers('+1 647 671 7297'), ['16476717297']);
    assert.deepEqual(candidateNumbers('970599123456'), ['970599123456']);
  });

  it('reads Arabic digits', () => {
    assert.deepEqual(candidateNumbers('٠٥٩٩١٢٣٤٥٦'), ['970599123456', '972599123456']);
  });

  it('refuses what is not a number', () => {
    assert.deepEqual(candidateNumbers(''), []);
    assert.deepEqual(candidateNumbers('abc'), []);
    assert.deepEqual(candidateNumbers('12345'), []);
    assert.deepEqual(candidateNumbers('0212345678'), []);
  });
});
