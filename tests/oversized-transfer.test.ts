import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromTokenUnits, USDT_DECIMALS } from '../src/modules/usdt/providers/types.ts';

/**
 * The scam airdrop that stopped a wallet's sync.
 *
 * A worthless token was sent to the office's address carrying the largest
 * number the token standard allows. Scaled to this system's eight decimal
 * places it does not fit the column, the insert failed, and the whole poll
 * failed with it — so every genuine arrival after it went unseen.
 *
 * The values below are the real ones from that log line. They are here so the
 * next person reads a case rather than a constant.
 */

/** A signed 64-bit column holds this and no more. */
const LARGEST_STORABLE = 2n ** 63n - 1n;

/** What the provider handed us, scaled, on 2026-08-19. */
const THE_AIRDROP =
  11579208923731619542357098500868790785326998466564056403945758400791312963993500n;

describe('a transfer too large to store', () => {
  it('is the column maximum, not an invented threshold', () => {
    assert.equal(LARGEST_STORABLE, 9223372036854775807n);
  });

  it('is what the real airdrop produced', () => {
    assert.ok(
      THE_AIRDROP > LARGEST_STORABLE,
      'the value that broke the sync should be above what can be stored',
    );
  });

  it('comes from a token carrying the largest number its standard allows', () => {
    // uint256 max, at six decimals, is the shape of the value above.
    const maxUint256 = 2n ** 256n - 1n;
    assert.ok(fromTokenUnits(maxUint256, USDT_DECIMALS) > LARGEST_STORABLE);
  });

  it('leaves every amount an office actually sees well inside the limit', () => {
    // A million USDT scales to 1e14; the ceiling is 9.2e18, so the largest
    // figure this counter will ever see has four orders of magnitude to spare.
    const aMillion = fromTokenUnits(1_000_000_000_000n, USDT_DECIMALS);
    assert.equal(aMillion, 100_000_000_000_000n);
    assert.ok(aMillion * 10_000n < LARGEST_STORABLE, String(aMillion));
  });
});
