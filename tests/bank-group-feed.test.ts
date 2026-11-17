import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWatched } from '../src/modules/bank/group-feed.service.ts';

describe('the groups the bank desk follows, as stored', () => {
  it('reads them stored as a list or as its JSON', () => {
    const groups = [{ id: '120363@g.us', name: 'تحويلات بنك' }];
    assert.deepEqual(parseWatched(groups), groups);
    assert.deepEqual(parseWatched(JSON.stringify(groups)), groups);
  });

  it('keeps only groups, and reads anything broken as none', () => {
    assert.deepEqual(parseWatched([{ id: '972599@s.whatsapp.net', name: 'x' }]), []);
    assert.deepEqual(parseWatched('not json'), []);
    assert.deepEqual(parseWatched(null), []);
    assert.deepEqual(parseWatched({ id: 'a@g.us' }), []);
  });
});
