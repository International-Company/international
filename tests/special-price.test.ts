// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mayGrantOwn } from '../src/modules/exchange/price-exception.service.ts';

/**
 * A special price the teller gives himself.
 *
 * Inside the office's percentage of the board, and never at or past what the
 * currency costs, it applies at once; anything else still goes to the manager.
 * Pinned because it is the line between the counter's freedom and the office's
 * money.
 */

const R = (rate: number) => BigInt(Math.round(rate * 100_000_000));

describe('who may give a special price', () => {
  it('the teller, within his percentage of the board', () => {
    // Board 2.90; 1% allows up to 2.929.
    assert.equal(
      mayGrantOwn({ requestedRate: R(2.92), boardRate: R(2.9), costRate: R(3.0), selfPercent: 1 }),
      true,
    );
  });

  it('the manager, past it', () => {
    assert.equal(
      mayGrantOwn({ requestedRate: R(2.95), boardRate: R(2.9), costRate: R(3.0), selfPercent: 1 }),
      false,
    );
  });

  it('the manager, whenever the price would be at or past the office’s cost', () => {
    // Within 1%, but the office carries the dollar at 2.91: 2.92 loses money.
    assert.equal(
      mayGrantOwn({ requestedRate: R(2.92), boardRate: R(2.9), costRate: R(2.91), selfPercent: 1 }),
      false,
    );
    assert.equal(
      mayGrantOwn({ requestedRate: R(2.91), boardRate: R(2.9), costRate: R(2.91), selfPercent: 1 }),
      false,
      'at cost is not above it',
    );
  });

  it('the teller, on the percentage alone, while no cost has been approved', () => {
    assert.equal(
      mayGrantOwn({ requestedRate: R(2.92), boardRate: R(2.9), costRate: null, selfPercent: 1 }),
      true,
    );
  });

  it('nobody but the manager, when the office sets the allowance to zero', () => {
    assert.equal(
      mayGrantOwn({ requestedRate: R(2.901), boardRate: R(2.9), costRate: null, selfPercent: 0 }),
      false,
    );
  });

  it('reads a fractional percentage exactly', () => {
    // 0.5% of 2.90 is 0.0145: 2.9145 is the edge, inclusive.
    assert.equal(
      mayGrantOwn({
        requestedRate: R(2.9145),
        boardRate: R(2.9),
        costRate: null,
        selfPercent: 0.5,
      }),
      true,
    );
    assert.equal(
      mayGrantOwn({
        requestedRate: R(2.9146),
        boardRate: R(2.9),
        costRate: null,
        selfPercent: 0.5,
      }),
      false,
    );
  });

  it('the teller, always, when the office lets him set any price', () => {
    // Past the percentage and past cost alike: the office chose to trust the
    // counter, and the manager is told instead.
    assert.equal(
      mayGrantOwn({
        requestedRate: R(3.2),
        boardRate: R(2.9),
        costRate: R(3.0),
        selfPercent: 0,
        unlimited: true,
      }),
      true,
    );
  });
});
