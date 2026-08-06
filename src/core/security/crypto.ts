import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual as nodeTimingSafeEqual,
} from 'node:crypto';
import { env } from '@/core/config/env';

/**
 * Cryptographic primitives, built on Node's audited implementations only.
 * No third-party crypto dependency is used anywhere in this system.
 */

// ---------------------------------------------------------------------------
// Hashing & random
// ---------------------------------------------------------------------------

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256(key: string | Buffer, input: string | Buffer): string {
  return createHmac('sha256', key).update(input).digest('hex');
}

/** URL-safe random token. 32 bytes = 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Human-friendly code (recovery codes, references). Excludes lookalike chars. */
export function randomCode(length = 10): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[buf[i]! % alphabet.length];
  }
  return out;
}

/** Constant-time comparison that tolerates differing lengths. */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure path takes similar time.
    nodeTimingSafeEqual(bufA, bufA);
    return false;
  }
  return nodeTimingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Symmetric encryption — for API credentials stored at rest
// ---------------------------------------------------------------------------

/** Derives a stable 32-byte key from AUTH_SECRET for the given purpose. */
function deriveKey(purpose: string): Buffer {
  return scryptSync(env.AUTH_SECRET, `ifms:${purpose}`, 32);
}

const ENCRYPTION_VERSION = 'v1';

/**
 * AES-256-GCM. Output: `v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`.
 * GCM is authenticated, so tampering is detected on decrypt.
 */
export function encryptSecret(plaintext: string, purpose = 'secrets'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(payload: string, purpose = 'secrets'): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== ENCRYPTION_VERSION) {
    throw new Error('Malformed ciphertext');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(purpose), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Canonical serialization — used by the audit hash chain
// ---------------------------------------------------------------------------

/**
 * Re-exported from a dependency-free module so it can be unit-tested without
 * pulling in the environment loader. See `./canonical` for why determinism
 * matters here.
 */
export { canonicalize } from './canonical';
