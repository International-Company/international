import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing primitives.
 *
 * Split out of `password.ts` (which is `server-only`) so build-time tooling —
 * the database seeder, migrations, tests — can reuse the exact same hashing
 * rather than re-implementing it and drifting out of step. Nothing here is
 * importable from a browser bundle regardless: `node:crypto` would fail to
 * resolve.
 *
 * scrypt is memory-hard, ships in Node's standard library, and needs no native
 * build step on any platform. Parameters follow the RFC 7914 interactive-login
 * recommendation (N=2^15, r=8, p=1) — roughly 32 MB and ~80 ms per verify.
 * They are embedded in the stored string, so they can be raised later and old
 * hashes still verify (and are upgraded on the next successful sign-in).
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** Node's default 32 MB cap is below what N=2^15 needs; give it headroom. */
function maxmemFor(N: number, r: number): number {
  return 256 * N * r * 2;
}

/** Format: `scrypt$N$r$p$salt$hash`, all base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const { N, r, p } = SCRYPT_PARAMS;

  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r),
  });

  return ['scrypt', N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');

  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a hash was produced with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT_PARAMS.N;
}

/**
 * Generates a policy-compliant password for new accounts and resets.
 *
 * Lives here rather than in the policy module so the seeder can use it when
 * provisioning the first administrator — that account must never be created
 * with a password anyone could read in a repository.
 *
 * Lookalike characters (0/O, 1/l/I) are excluded because these get read aloud
 * and copied by hand.
 */
export function generatePassword(length = 14): string {
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_=+';
  const all = upper + lower + digits + symbols;

  const pick = (set: string) => set[randomBytes(1)[0]! % set.length]!;
  // Guarantee one of each class so the result always satisfies the policy.
  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));

  // Fisher-Yates with crypto randomness, so the guaranteed characters are not
  // predictably in the first four positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}
