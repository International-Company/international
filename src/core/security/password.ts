import 'server-only';
import type { FieldIssue } from '@/core/errors/app-error';

/**
 * Password policy.
 *
 * The hashing primitives live in `./scrypt` so build-time tooling (the seeder,
 * tests) can share them without tripping the `server-only` guard. They are
 * re-exported here so application code has a single import for everything
 * password-related.
 */
export {
  hashPassword,
  verifyPassword,
  needsRehash,
  generatePassword,
  SCRYPT_PARAMS,
} from './scrypt';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSymbol: boolean;
  /** How many previous passwords may not be reused. 0 disables the check. */
  historyDepth: number;
  /** Force a change after this many days. 0 disables expiry. */
  maxAgeDays: number;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 10,
  requireUppercase: true,
  requireLowercase: true,
  requireNumber: true,
  requireSymbol: false,
  historyDepth: 5,
  maxAgeDays: 90,
};

/** Passwords that are common enough to be tried first in any attack. */
const BLOCKLIST = new Set([
  'password', 'password1', 'password123', '123456', '12345678', '123456789',
  'qwerty', 'qwerty123', 'admin', 'admin123', 'welcome', 'welcome1',
  'letmein', 'changeme', 'iloveyou', 'abc123', 'monkey', 'dragon',
  'ifms', 'ifms123', 'exchange', 'exchange123',
]);

/**
 * Validates a password against the policy. Returns i18n keys rather than
 * sentences so the message can be rendered in Arabic or English.
 */
export function validatePassword(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
  context: { username?: string; email?: string; fullName?: string } = {},
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  const add = (code: string, message: string) =>
    issues.push({ path: 'password', code, message });

  if (password.length < policy.minLength) {
    add('minLength', `Password must be at least ${policy.minLength} characters`);
  }
  if (password.length > 200) {
    add('maxLength', 'Password must be at most 200 characters');
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    add('uppercase', 'Password must contain an uppercase letter');
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    add('lowercase', 'Password must contain a lowercase letter');
  }
  if (policy.requireNumber && !/\d/.test(password)) {
    add('number', 'Password must contain a number');
  }
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    add('symbol', 'Password must contain a symbol');
  }

  const lowered = password.toLowerCase();
  if (BLOCKLIST.has(lowered)) {
    add('common', 'Password is too common');
  }

  for (const [field, value] of Object.entries(context)) {
    if (!value || value.length < 4) continue;
    if (lowered.includes(value.toLowerCase())) {
      add('containsIdentity', `Password must not contain your ${field}`);
      break;
    }
  }

  if (/^(.)\1+$/.test(password)) {
    add('repeated', 'Password must not be a single repeated character');
  }

  return issues;
}

/** 0–4 strength estimate for the live meter in the UI. */
export function passwordStrength(password: string): number {
  if (!password) return 0;
  let score = 0;
  if (password.length >= 10) score++;
  if (password.length >= 14) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;
  if (BLOCKLIST.has(password.toLowerCase())) return 0;
  return Math.min(4, score);
}

// `generatePassword` is re-exported from ./scrypt at the top of this file.
