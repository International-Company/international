// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clearSession } from '../src/modules/whatsapp/auth-state.ts';
import { tellerSessionPrefix } from '../src/modules/whatsapp/accounts.ts';

/** A store of session keys, deleted from the way Prisma would. */
function store(keys: string[]) {
  const left = new Set(keys);
  type Where = { key?: { startsWith: string }; NOT?: { key: { startsWith: string } }[] };
  const matches = (key: string, where: Where) =>
    (!where.key || key.startsWith(where.key.startsWith)) &&
    !(where.NOT ?? []).some((not) => key.startsWith(not.key.startsWith));
  const db = {
    whatsappAuth: {
      deleteMany: async ({ where }: { where: Where }) => {
        for (const key of [...left]) if (matches(key, where)) left.delete(key);
        return { count: 0 };
      },
    },
  };
  return { db: db as never, left };
}

describe('forgetting one linked number', () => {
  const teller = tellerSessionPrefix('user1');
  const keys = [
    'creds',
    'session-1',
    'second:creds',
    'private:creds',
    `${teller}creds`,
    `${teller}session-9`,
  ];

  it('leaves every teller’s number when the first number is unlinked', async () => {
    const { db, left } = store(keys);
    await clearSession(db, '');
    assert.deepEqual(
      [...left].sort(),
      ['private:creds', 'second:creds', `${teller}creds`, `${teller}session-9`].sort(),
    );
  });

  it('takes a teller’s number alone when it is unlinked', async () => {
    const { db, left } = store(keys);
    await clearSession(db, teller);
    assert.deepEqual(
      [...left].sort(),
      ['creds', 'private:creds', 'second:creds', 'session-1'].sort(),
    );
  });
});
