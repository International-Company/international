// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { intakeShares, paidBothWaysPayout } from '../src/modules/exchange/intake-split.ts';
import { balancesFor } from '../src/modules/exchange/transaction-types.ts';

/**
 * العميل يدفع مزدوج — part by transfer, the rest in notes. Pinned: the two
 * shares always add up to what was paid, a transfer that is all of it or none
 * is refused, and each share is priced at its own channel and rounded on its
 * own before they are added.
 */

const UNIT = 100_000_000n;

describe('a customer paying both ways', () => {
  it('divides what is paid into a transfer and the notes that make up the rest', () => {
    assert.deepEqual(intakeShares(800n * UNIT, 500n * UNIT), {
      cash: 300n * UNIT,
      broker: 500n * UNIT,
    });
    // A fraction stays exact.
    assert.deepEqual(intakeShares(10_050n * (UNIT / 100n), 3_333n * (UNIT / 100n)), {
      cash: 6_717n * (UNIT / 100n),
      broker: 3_333n * (UNIT / 100n),
    });
  });

  it('refuses a transfer that is none, all, or more than the money paid', () => {
    assert.equal(intakeShares(800n * UNIT, 0n), null);
    assert.equal(intakeShares(800n * UNIT, 800n * UNIT), null);
    assert.equal(intakeShares(800n * UNIT, 900n * UNIT), null);
    assert.equal(intakeShares(800n * UNIT, -1n), null);
  });

  it('prices the transfer at the bank rate and the notes at the till rate', () => {
    // 1000 USD: 600 transferred at 3.62, 400 in notes at 3.65 → 2172 + 1460.
    const total = paidBothWaysPayout(
      { cash: 400n * UNIT, broker: 600n * UNIT },
      { cash: 365_000_000n, broker: 362_000_000n },
      2,
    );
    assert.equal(total, 3_632n * UNIT);
  });

  it('rounds each share on its own, as the server posts it', () => {
    // 100 ILS → USD: 33.33 by transfer at 0.2739, 66.67 in notes at 0.2747.
    // 9.129087 → 9.13, and 18.314249 → 18.31; 27.44 together.
    const total = paidBothWaysPayout(
      { cash: 6_667_000_000n, broker: 3_333_000_000n },
      { cash: 27_470_000n, broker: 27_390_000n },
      2,
    );
    assert.equal(total, 2_744_000_000n);
  });

  it('can take part of an exchange through the broker on the way in', () => {
    // The side the machine records a split intake on is not pinned to one balance.
    assert.equal(balancesFor('EXCHANGE').intake, null);
  });
});
