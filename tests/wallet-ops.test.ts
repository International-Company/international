// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { walletShape } from '../src/modules/exchange/wallet-ops.service.ts';
import {
  balancesFor,
  CATEGORIES,
  MACHINE_TYPES,
  TRANSACTION_TYPES,
} from '../src/modules/exchange/transaction-types.ts';

/**
 * The counter's wallet services, and the machine's new way in.
 *
 * Pinned: which way the money moves for a cash-out and a top-up, that the fee
 * is the gap between the two sides, and that the machine's work — including
 * an exchange paid by transfer — can come in through either balance.
 */

const UNIT = 100_000_000n;

describe('a wallet cash-out', () => {
  it('takes the amount in by transfer and hands it back in notes, less the fee', () => {
    const shape = walletShape('CASHOUT', 1_000n * UNIT, 10n * UNIT);

    assert.equal(shape.type, 'WALLET_CASHOUT');
    assert.deepEqual(shape.intake, { cash: 0n, broker: 1_000n * UNIT });
    assert.deepEqual(shape.payout, { cash: 990n * UNIT, bank: 0n });
    assert.equal(shape.fromAmount - shape.toAmount, 10n * UNIT, 'the fee is the gap');
  });

  it('with no fee, hands back exactly what came in', () => {
    const shape = walletShape('CASHOUT', 500n * UNIT, 0n);
    assert.equal(shape.toAmount, 500n * UNIT);
  });
});

describe('a wallet top-up', () => {
  it('takes the amount and the fee in notes, and transfers the amount', () => {
    const shape = walletShape('TOPUP', 1_000n * UNIT, 15n * UNIT);

    assert.equal(shape.type, 'WALLET_TOPUP');
    assert.deepEqual(shape.intake, { cash: 1_015n * UNIT, broker: 0n });
    assert.deepEqual(shape.payout, { cash: 0n, bank: 1_000n * UNIT });
    assert.equal(shape.fromAmount - shape.toAmount, 15n * UNIT, 'the fee is the gap');
  });
});

describe('the machine’s types', () => {
  it('are all real types, counted as exchange work', () => {
    for (const type of MACHINE_TYPES) {
      assert.ok((TRANSACTION_TYPES as readonly string[]).includes(type), type);
      assert.ok((CATEGORIES.EXCHANGE as readonly string[]).includes(type), type);
    }
  });

  it('can come in and go out through either balance', () => {
    for (const type of MACHINE_TYPES) {
      assert.deepEqual(balancesFor(type), { intake: null, payout: null }, type);
    }
  });

  it('leave a remittance and USDT pinned as they were', () => {
    assert.deepEqual(balancesFor('REMITTANCE_OUT'), { intake: 'CASH', payout: 'CORRESPONDENT' });
    assert.deepEqual(balancesFor('USDT_RECEIVE'), { intake: 'CASH', payout: null });
    assert.deepEqual(balancesFor('USDT_SEND'), { intake: null, payout: 'CASH' });
  });
});
