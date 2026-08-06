import 'server-only';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 TOTP, implemented directly on node:crypto.
 *
 * The system stores a secret per user and exposes enrolment through the admin
 * screens; enabling the second factor for an account is a settings toggle, not
 * a code change.
 */

const DIGITS = 6;
const PERIOD_SECONDS = 30;
/** Accept one step either side to tolerate clock drift. */
const DEFAULT_WINDOW = 1;

// --- Base32 (RFC 4648, no padding) ----------------------------------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += B32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = B32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// --- TOTP ------------------------------------------------------------------

/** 20 bytes = 160 bits, the RFC 4226 recommended secret size. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);

  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return (binary % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export function generateTotp(secretBase32: string, atMs: number = Date.now()): string {
  const counter = BigInt(Math.floor(atMs / 1000 / PERIOD_SECONDS));
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * Verifies a submitted code. Comparison is constant-time and the accepted
 * window is deliberately small — a wider window meaningfully weakens the factor.
 */
export function verifyTotp(
  token: string,
  secretBase32: string,
  options: { window?: number; atMs?: number } = {},
): boolean {
  const { window = DEFAULT_WINDOW, atMs = Date.now() } = options;

  const normalized = token.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;

  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return false;
  }

  const counter = BigInt(Math.floor(atMs / 1000 / PERIOD_SECONDS));
  const submitted = Buffer.from(normalized, 'utf8');

  let matched = false;
  // Check every step in the window regardless of an early match, so the
  // response time does not reveal which step succeeded.
  for (let offset = -window; offset <= window; offset++) {
    const candidate = Buffer.from(hotp(secret, counter + BigInt(offset)), 'utf8');
    if (candidate.length === submitted.length && timingSafeEqual(candidate, submitted)) {
      matched = true;
    }
  }
  return matched;
}

/** Seconds until the current code rolls over — drives the UI countdown. */
export function secondsUntilRollover(atMs: number = Date.now()): number {
  return PERIOD_SECONDS - (Math.floor(atMs / 1000) % PERIOD_SECONDS);
}

/** `otpauth://` URI for authenticator apps (rendered as a QR code). */
export function buildOtpAuthUri(options: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${options.issuer}:${options.accountName}`);
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
