import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseAccount, firstSighting } from '../src/modules/whatsapp/accounts.ts';

const SERVICES = 'services@g.us';
const EXEC = 'exec@g.us';
const BOTH = 'both@g.us';
const memberOf = {
  main: new Set([SERVICES, BOTH]),
  second: new Set([EXEC, BOTH]),
};

describe('which number writes to a chat', () => {
  it('is the one in the group', () => {
    assert.equal(chooseAccount(SERVICES, ['main', 'second'], memberOf), 'main');
    assert.equal(chooseAccount(EXEC, ['main', 'second'], memberOf), 'second');
  });

  it('is the first when both are in it', () => {
    assert.equal(chooseAccount(BOTH, ['main', 'second'], memberOf), 'main');
  });

  it('is one that is linked, even if the other is in the group', () => {
    assert.equal(chooseAccount(SERVICES, ['second'], memberOf), 'second');
    assert.equal(chooseAccount(EXEC, ['main'], memberOf), 'main');
  });

  it('is the first linked for a group neither is known to be in, or a person', () => {
    assert.equal(chooseAccount('new@g.us', ['main', 'second'], memberOf), 'main');
    assert.equal(chooseAccount('970599000000@s.whatsapp.net', ['main', 'second'], memberOf), 'main');
    assert.equal(chooseAccount(EXEC, ['main', 'second'], {}), 'main');
  });

  it('is none when nothing is linked', () => {
    assert.equal(chooseAccount(SERVICES, [], memberOf), null);
  });
});

describe('a message both numbers see', () => {
  it('is handled once', () => {
    const seen: string[] = [];
    assert.equal(firstSighting(seen, 'g:1'), true);
    assert.equal(firstSighting(seen, 'g:1'), false);
    assert.equal(firstSighting(seen, 'g:2'), true);
  });

  it('is remembered only so long', () => {
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) firstSighting(seen, `m${i}`, 3);
    assert.deepEqual(seen, ['m2', 'm3', 'm4']);
    assert.equal(firstSighting(seen, 'm0', 3), true);
  });
});
