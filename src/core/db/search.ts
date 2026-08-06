import { env } from '@/core/config/env';

/**
 * Portable case-insensitive text matching.
 *
 * SQLite's `LIKE` is case-insensitive for ASCII by default, so `contains`
 * already ignores case there. PostgreSQL's `LIKE` is case-sensitive, and Prisma
 * only accepts `mode: 'insensitive'` on PostgreSQL — passing it to SQLite is a
 * query-time error.
 *
 * Without this, the same search box would behave differently depending on which
 * database the deployment happens to use: a teller typing "ahmad" would find
 * "Ahmad" locally and nothing at all in production. Every text search in the
 * system goes through here so that cannot happen.
 */

export type DatabaseProvider = 'sqlite' | 'postgresql' | 'mysql';

/** Derived from the connection string — the same signal the schema uses. */
export function databaseProvider(url = env.DATABASE_URL): DatabaseProvider {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgresql';
  if (url.startsWith('mysql://')) return 'mysql';
  return 'sqlite';
}

const PROVIDER = databaseProvider();

/** True when the provider needs an explicit insensitive mode. */
const NEEDS_EXPLICIT_MODE = PROVIDER === 'postgresql';

export interface ContainsFilter {
  contains: string;
  mode?: 'insensitive';
}

/**
 * Builds a case-insensitive "contains" filter for the active provider.
 *
 *   { fullNameEn: containsInsensitive(term) }
 */
export function containsInsensitive(value: string): ContainsFilter {
  return NEEDS_EXPLICIT_MODE ? { contains: value, mode: 'insensitive' } : { contains: value };
}

/** Same, for an exact match that should ignore case (codes, references). */
export function equalsInsensitive(value: string): { equals: string; mode?: 'insensitive' } {
  return NEEDS_EXPLICIT_MODE ? { equals: value, mode: 'insensitive' } : { equals: value };
}
