import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isFullName } from '../src/modules/usdt/person-name.ts';

describe('a person’s whole name', () => {
  it('takes two words or more, in Arabic or English', () => {
    for (const name of ['محمد احمد', ' أبو خالد ', 'عبد الله بن علي', 'Ali Hasan', "Sa'ad Al-Masri"]) {
      assert.equal(isFullName(name), true, name);
    }
  });

  it('refuses half a name, a stray letter, or figures', () => {
    for (const name of ['', '  ', 'محمد', 'م', 'م ا', 'محمد ا', 'محمد 123', '0597 000000']) {
      assert.equal(isFullName(name), false, name);
    }
  });
});
