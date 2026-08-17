import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addressOf,
  addressToBytes,
  bytesToAddress,
  encodeTransfer,
  parsePrivateKey,
  signTxId,
} from '../src/modules/usdt/tron-signer.ts';

/**
 * The bytes that move the office's coins.
 *
 * Every value here is checkable against something outside this repository: the
 * USDT contract address is public, the `transfer` selector is the same four
 * bytes on every token there has ever been, and the key/address pair is the
 * canonical one every TRON library tests with. If any of these drift, coins go
 * to the wrong place and no later entry brings them back — which is why this
 * file exists before the service that calls it.
 */

/** Private key `1`, and the address it controls. */
const KEY_ONE = '0000000000000000000000000000000000000000000000000000000000000001';
const ADDRESS_ONE = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';

/**
 * Tether on TRON, and the twenty bytes behind it.
 *
 * This pair is the anchor of the whole file. The address is public and the hex
 * is what every explorer and every contract call shows for it — neither was
 * chosen here, so an implementation that produces this one is decoding base58,
 * verifying the checksum and stripping the prefix the way the chain does.
 */
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

describe('TRON addresses', () => {
  it('derives the published address from the published key', () => {
    assert.equal(addressOf(parsePrivateKey(KEY_ONE)), ADDRESS_ONE);
  });

  it('accepts an 0x prefix and stray whitespace on a key', () => {
    assert.equal(addressOf(parsePrivateKey(`  0x${KEY_ONE}  `)), ADDRESS_ONE);
  });

  it('refuses a key that is not thirty-two bytes', () => {
    assert.throws(() => parsePrivateKey(KEY_ONE.slice(1)), /64 hexadecimal/);
    assert.throws(() => parsePrivateKey(`${KEY_ONE}ff`), /64 hexadecimal/);
    assert.throws(() => parsePrivateKey('not a key'), /64 hexadecimal/);
  });

  it('round-trips an address through its bytes', () => {
    assert.equal(bytesToAddress(addressToBytes(USDT)), USDT);
    assert.equal(bytesToAddress(addressToBytes(ADDRESS_ONE)), ADDRESS_ONE);
  });

  it('decodes the public contract to the hex every explorer shows', () => {
    assert.equal(Buffer.from(addressToBytes(USDT)).toString('hex'), USDT_HEX);
  });

  it('decodes to twenty-one bytes behind the mainnet prefix', () => {
    const bytes = addressToBytes(USDT);
    assert.equal(bytes.length, 21);
    assert.equal(bytes[0], 0x41);
  });

  it('refuses an address whose checksum does not hold', () => {
    // One character changed: the shape survives, the checksum does not.
    const broken = `${USDT.slice(0, -1)}u`;
    assert.throws(() => addressToBytes(broken), /checksum|not a TRON address/);
  });

  it('refuses something that is not an address at all', () => {
    assert.throws(() => addressToBytes('hello'), /not a TRON address|checksum/);
    assert.throws(() => addressToBytes('0xdAC17F958D2ee523a2206206994597C13D831ec7'), /not a TRON/);
  });
});

describe('the transfer call', () => {
  it('opens with the selector every token shares', () => {
    // keccak256('transfer(address,uint256)')[0..4] — a published constant.
    assert.match(encodeTransfer(ADDRESS_ONE, 1n), /^a9059cbb/);
  });

  it('is a selector and two padded words, and nothing else', () => {
    const data = encodeTransfer(ADDRESS_ONE, 1n);
    assert.equal(data.length, 8 + 64 + 64);
  });

  it('carries the recipient without its network prefix', () => {
    const data = encodeTransfer(ADDRESS_ONE, 1n);
    const twenty = Buffer.from(addressToBytes(ADDRESS_ONE).slice(1)).toString('hex');
    assert.equal(data.slice(8, 72), twenty.padStart(64, '0'));
  });

  it('carries the amount in the token’s own units', () => {
    // 12.34 USDT is 12_340_000 at six decimals.
    const data = encodeTransfer(ADDRESS_ONE, 12_340_000n);
    assert.equal(BigInt(`0x${data.slice(72)}`), 12_340_000n);
  });

  it('refuses to encode nothing', () => {
    assert.throws(() => encodeTransfer(ADDRESS_ONE, 0n), /greater than zero/);
    assert.throws(() => encodeTransfer(ADDRESS_ONE, -1n), /greater than zero/);
  });

  it('refuses a recipient that fails its checksum before any of this matters', () => {
    assert.throws(() => encodeTransfer(`${ADDRESS_ONE.slice(0, -1)}u`, 1n), /checksum|not a TRON/);
  });
});

describe('signing', () => {
  const key = parsePrivateKey(KEY_ONE);
  const txId = 'a'.repeat(64);

  it('produces sixty-five bytes: r, s, and the recovery byte last', () => {
    const signature = signTxId(txId, key);
    assert.equal(signature.length, 130);
    const recovery = Number.parseInt(signature.slice(128), 16);
    assert.ok(recovery === 0 || recovery === 1, `recovery byte was ${recovery}`);
  });

  it('is deterministic, so the same transaction signs the same way twice', () => {
    assert.equal(signTxId(txId, key), signTxId(txId, key));
  });

  it('changes completely when the transaction does', () => {
    assert.notEqual(signTxId(txId, key), signTxId('b'.repeat(64), key));
  });

  it('refuses anything that is not a transaction id', () => {
    assert.throws(() => signTxId('short', key), /transaction id/);
    assert.throws(() => signTxId(`${txId}ff`, key), /transaction id/);
  });
});
