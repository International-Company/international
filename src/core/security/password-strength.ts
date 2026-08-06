/**
 * Client-safe password strength estimate.
 *
 * Deliberately separate from `password.ts`, which is `server-only` because it
 * imports node:crypto. The live strength meter runs in the browser, so the
 * scoring rule lives here and both sides import the same one — a meter that
 * disagrees with the policy that will reject the password is worse than none.
 */

const COMMON = new Set([
  'password', 'password1', 'password123', '123456', '12345678', '123456789',
  'qwerty', 'qwerty123', 'admin', 'admin123', 'welcome', 'welcome1',
  'letmein', 'changeme', 'iloveyou', 'abc123', 'monkey', 'dragon',
  'ifms', 'ifms123', 'exchange', 'exchange123',
]);

/** 0–4. Mirrors `passwordStrength` in the server-side password module. */
export function passwordStrength(password: string): number {
  if (!password) return 0;
  if (COMMON.has(password.toLowerCase())) return 0;

  let score = 0;
  if (password.length >= 10) score++;
  if (password.length >= 14) score++;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  return Math.min(4, score);
}

/** The client-side mirror of the server policy, for inline form feedback. */
export interface PasswordRule {
  key: string;
  test: (password: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { key: 'passwordMinLength', test: (p) => p.length >= 10 },
  { key: 'passwordUppercase', test: (p) => /[A-Z]/.test(p) },
  { key: 'passwordLowercase', test: (p) => /[a-z]/.test(p) },
  { key: 'passwordNumber', test: (p) => /\d/.test(p) },
];

export function unmetRules(password: string): string[] {
  return PASSWORD_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.key);
}
