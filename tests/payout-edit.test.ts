import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyPayoutEdit,
  tellerPriceAllowed,
  withinEditLimit,
} from '../src/modules/usdt/payout-edit.ts';

/**
 * Changing what a USDT receipt pays. Pinned: the total always equals the figure
 * typed, a split changes only the transfer, and a slip far from the computed
 * figure is refused rather than paid.
 */

const UNIT = 100_000_000n;

describe('editing what a USDT receipt pays', () => {
  it('takes the new total on a deal paid one way', () => {
    assert.deepEqual(applyPayoutEdit({ cash: 985n * UNIT, bank: 0n }, 990n * UNIT, 5), {
      cash: 990n * UNIT,
      bank: 0n,
    });
    assert.deepEqual(applyPayoutEdit({ cash: 0n, bank: 985n * UNIT }, 980n * UNIT, 5), {
      cash: 0n,
      bank: 980n * UNIT,
    });
  });

  it('puts the difference on the transfer when paid part each', () => {
    const legs = { cash: 594n * UNIT, bank: 392n * UNIT };
    assert.deepEqual(applyPayoutEdit(legs, 990n * UNIT, 5), {
      cash: 594n * UNIT,
      bank: 396n * UNIT,
    });
  });

  it('refuses a typing slip beyond the limit', () => {
    const legs = { cash: 990n * UNIT, bank: 0n };
    assert.equal(applyPayoutEdit(legs, 9900n * UNIT, 5), 'errors.payoutEditTooFar');
    assert.equal(applyPayoutEdit(legs, 99n * UNIT, 5), 'errors.payoutEditTooFar');
  });

  it('allows up to the limit exactly, on either side', () => {
    assert.equal(withinEditLimit(1000n * UNIT, 1050n * UNIT, 5), true);
    assert.equal(withinEditLimit(1000n * UNIT, 950n * UNIT, 5), true);
    assert.equal(withinEditLimit(1000n * UNIT, 1051n * UNIT, 5), false);
    assert.equal(withinEditLimit(1000n * UNIT, 1025n * UNIT, 2.5), true);
  });

  it('takes a teller’s own price in shekels only', () => {
    assert.equal(tellerPriceAllowed('ILS'), true);
    assert.equal(tellerPriceAllowed('ils'), true);
    assert.equal(tellerPriceAllowed('USD'), false);
    assert.equal(tellerPriceAllowed('JOD'), false);
  });

  it('holds a price to the limit, so 3.65 mistyped as 36.5 is refused', () => {
    const board = 360_000_000n;
    assert.equal(withinEditLimit(board, 365_000_000n, 5), true);
    assert.equal(withinEditLimit(board, 3_650_000_000n, 5), false);
    assert.equal(withinEditLimit(board, 36_500_000n, 5), false);
  });

  it('has no limit when the office sets none', () => {
    assert.equal(withinEditLimit(1000n * UNIT, 9000n * UNIT, 0), true);
  });

  it('refuses nothing paid, and a split whose transfer would vanish', () => {
    assert.equal(
      applyPayoutEdit({ cash: 100n * UNIT, bank: 0n }, 0n, 0),
      'errors.payoutEditInvalid',
    );
    assert.equal(
      applyPayoutEdit({ cash: 500n * UNIT, bank: 10n * UNIT }, 500n * UNIT, 5),
      'errors.payoutEditInvalid',
    );
  });
});
