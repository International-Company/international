// Must precede the service import — see the note in that file.
import './support/test-env.ts';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readToken, verificationToken } from '../src/modules/exchange/receipt-verify.ts';

/**
 * The receipt's QR code. Pinned: a code the system signed reads back to its
 * reference, and one with any part changed — the reference or the signature —
 * reads as not ours, so a forged QR cannot open a real transaction's page.
 */
describe('a receipt verification code', () => {
  it('reads back to the reference it was made for', () => {
    const token = verificationToken('TXN-20261026-00010');
    assert.equal(readToken(token), 'TXN-20261026-00010');
  });

  it('is refused when the reference is changed', () => {
    const token = verificationToken('TXN-20261026-00010');
    assert.equal(readToken(token.replace('00010', '00011')), null);
  });

  it('is refused when the signature is changed or missing', () => {
    const token = verificationToken('TXN-20261026-00010');
    const flipped = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    assert.equal(readToken(flipped), null);
    assert.equal(readToken('TXN-20261026-00010'), null);
  });
});
