import 'server-only';
import { createHash, createHmac } from 'node:crypto';
import * as secp from '@noble/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { errors } from '@/core/errors/app-error';

/**
 * Turning a private key into a signed TRC-20 transfer.
 *
 * ## Why this is written out rather than handed to a wallet library
 *
 * The usual answer is `tronweb`, and it would work. It is also a large,
 * opaque dependency sitting in the one code path that can lose the office's
 * money without recourse. What that path actually needs is four small things —
 * decode an address, encode a call, hash, sign — each of which can be checked
 * against a published vector and each of which is here in full view.
 *
 * The two pieces that are genuinely hard are not written here: the elliptic
 * curve comes from `@noble/secp256k1` and keccak from `@noble/hashes`, both
 * audited and both doing exactly one thing. Hand-rolled curve arithmetic in a
 * payments path would be indefensible; hand-rolled base58 is arithmetic a test
 * can pin.
 *
 * ## What it deliberately does not do
 *
 * It does not decide whether to send. It does not know about limits, or
 * approvals, or which wallet is allowed. Those belong to the service above it,
 * and keeping them out of here means this file can be read as what it is: a
 * transformation from an intent to bytes.
 */

// The library takes its hashes from the host rather than bundling them.
secp.hashes.sha256 = (message: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(message).digest());
secp.hashes.hmacSha256 = (key: Uint8Array, message: Uint8Array) =>
  new Uint8Array(createHmac('sha256', key).update(message).digest());

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Mainnet addresses carry this prefix byte before their twenty. */
const ADDRESS_PREFIX = 0x41;

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('sha256').update(bytes).digest());

/** The four-byte checksum TRON and Bitcoin both append: sha256 twice, first four. */
const checksum = (payload: Uint8Array): Uint8Array => sha256(sha256(payload)).slice(0, 4);

function toBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);

  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  // Every leading zero byte is one leading '1', which the arithmetic above
  // cannot express because a leading zero has no value.
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

function fromBase58(text: string): Uint8Array {
  let value = 0n;
  for (const character of text) {
    const index = BASE58.indexOf(character);
    if (index < 0) throw errors.precondition(`${text} is not a TRON address`, 'errors.invalidAddress');
    value = value * 58n + BigInt(index);
  }

  const digits: number[] = [];
  while (value > 0n) {
    digits.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const character of text) {
    if (character !== '1') break;
    digits.unshift(0);
  }
  return new Uint8Array(digits);
}

/**
 * A base58 address as the twenty-one bytes the chain speaks.
 *
 * The checksum is verified rather than trimmed. A mistyped address usually
 * fails it, and finding that out here costs nothing while finding it out after
 * a broadcast costs the whole transfer.
 */
export function addressToBytes(address: string): Uint8Array {
  const decoded = fromBase58(address.trim());
  if (decoded.length !== 25) {
    throw errors.precondition(`${address} is not a TRON address`, 'errors.invalidAddress');
  }

  const payload = decoded.slice(0, 21);
  const given = decoded.slice(21);
  const expected = checksum(payload);

  for (let index = 0; index < 4; index++) {
    if (given[index] !== expected[index]) {
      throw errors.precondition(`${address} fails its own checksum`, 'errors.invalidAddress');
    }
  }
  if (payload[0] !== ADDRESS_PREFIX) {
    throw errors.precondition(`${address} is not a mainnet address`, 'errors.invalidAddress');
  }
  return payload;
}

/** The same twenty-one bytes written the way a person reads them. */
export function bytesToAddress(payload: Uint8Array): string {
  const full = new Uint8Array(25);
  full.set(payload, 0);
  full.set(checksum(payload), 21);
  return toBase58(full);
}

/**
 * The address a private key controls.
 *
 * Used to check a configured hot wallet against the key that is supposed to
 * open it. A key pasted one character short produces a valid-looking address
 * for an account nobody has ever funded, and the first anyone would know is a
 * transfer that never appears.
 */
export function addressOf(privateKey: Uint8Array): string {
  const uncompressed = secp.getPublicKey(privateKey, false); // 0x04 || X || Y
  const hashed = keccak_256(uncompressed.slice(1));
  const payload = new Uint8Array(21);
  payload[0] = ADDRESS_PREFIX;
  payload.set(hashed.slice(-20), 1);
  return bytesToAddress(payload);
}

/** A 32-byte private key from the hex an operator pasted. */
export function parsePrivateKey(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw errors.precondition(
      'The wallet key must be 64 hexadecimal characters',
      'errors.hotWalletKeyInvalid',
    );
  }
  return new Uint8Array(Buffer.from(clean, 'hex'));
}

/**
 * The call data for `transfer(address,uint256)`.
 *
 * The selector is the first four bytes of keccak of that signature, and it is
 * the same constant on every ERC-20 and TRC-20 there has ever been. Both
 * arguments are padded to thirty-two bytes; the address contributes its twenty
 * without the network prefix, which is what makes a TRON contract call look
 * exactly like an Ethereum one.
 */
export function encodeTransfer(to: string, amount: bigint): string {
  if (amount <= 0n) {
    throw errors.precondition('Amount must be greater than zero', 'errors.amountNotPositive');
  }

  const selector = Buffer.from(keccak_256(new TextEncoder().encode('transfer(address,uint256)')))
    .subarray(0, 4)
    .toString('hex');

  const recipient = Buffer.from(addressToBytes(to).slice(1)).toString('hex').padStart(64, '0');
  const value = amount.toString(16).padStart(64, '0');

  if (value.length !== 64) {
    throw errors.precondition('That amount does not fit a uint256', 'errors.amountNotPositive');
  }

  return selector + recipient + value;
}

/**
 * Signs a transaction the node has already built.
 *
 * TRON signs the `txID`, which the node returns and which is the sha256 of the
 * serialised `raw_data`. The signature is `r || s || v` where `v` is the
 * recovery byte — the library hands it back with the recovery byte first, so it
 * moves to the end here rather than anywhere further from the line that made
 * it.
 */
export function signTxId(txId: string, privateKey: Uint8Array): string {
  if (!/^[0-9a-fA-F]{64}$/.test(txId)) {
    throw errors.precondition('The node returned an unusable transaction id', 'errors.chainRefused');
  }

  const digest = new Uint8Array(Buffer.from(txId, 'hex'));
  const recovered = secp.sign(digest, privateKey, { prehash: false, format: 'recovered' });

  const signature = new Uint8Array(65);
  signature.set(recovered.slice(1), 0); // r || s
  signature[64] = recovered[0]!; // v
  return Buffer.from(signature).toString('hex');
}
