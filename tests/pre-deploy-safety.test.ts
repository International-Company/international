import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
} from '../src/modules/exchange/transaction-types.ts';

/**
 * The deploy must never delete a transaction the system still knows.
 *
 * `scripts/pre-deploy-schema.mjs` runs on every deploy, and one of its steps
 * deletes the transactions the reduction of 6c64b60 retired. It used to pick
 * them as "anything not in today's list", and today's list stopped being
 * today's on 10 August: every deploy after that deleted every remittance,
 * every USDT send and every transfer awaiting confirmation.
 *
 * This reads the step itself and holds it to the current vocabulary, so the
 * next type or status anyone adds cannot be swept up by it either.
 */

const script = readFileSync(new URL('../scripts/pre-deploy-schema.mjs', import.meta.url), 'utf8');

/** The SQL of the step that deletes transactions. */
function removalStep(): string {
  const start = script.indexOf("name: 'Remove transactions the reduced model cannot express'");
  assert.ok(start >= 0, 'the removal step is where this test expects it');
  const end = script.indexOf('DELETE FROM "transactions"', start);
  assert.ok(end > start, 'the step still deletes from transactions');
  return script.slice(start, end);
}

/** Every quoted word inside the parentheses after `column IN` / `column NOT IN`. */
function listed(sql: string, column: string, negated: boolean): string[] {
  const pattern = new RegExp(`"${column}"\\s+${negated ? 'NOT\\s+IN' : 'IN'}\\s*\\(([^)]*)\\)`, 'g');
  return [...sql.matchAll(pattern)].flatMap((match) =>
    [...(match[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((word) => word[1]!),
  );
}

describe('the deploy’s removal of retired transactions', () => {
  const sql = removalStep();

  it('names what it removes instead of removing whatever is not listed', () => {
    assert.deepEqual(listed(sql, 'type', true), [], 'no "type NOT IN" — it ages into deleting new types');
    assert.deepEqual(listed(sql, 'status', true), [], 'no "status NOT IN" — same reason');
  });

  it('never names a type the system still records', () => {
    const doomed = listed(sql, 'type', false);
    for (const type of TRANSACTION_TYPES) {
      assert.ok(!doomed.includes(type), `${type} is live and would be deleted on every deploy`);
    }
  });

  it('never names a status the system still uses', () => {
    const doomed = listed(sql, 'status', false);
    for (const status of TRANSACTION_STATUSES) {
      assert.ok(!doomed.includes(status), `${status} is live and would be deleted on every deploy`);
    }
  });
});
