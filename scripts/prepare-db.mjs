#!/usr/bin/env node
/**
 * Aligns the Prisma datasource provider with DATABASE_URL.
 *
 * Prisma requires the provider to be a literal in the schema — it cannot be
 * read from the environment. This system is meant to run on SQLite locally
 * (zero setup) and PostgreSQL in production (Railway's filesystem is ephemeral,
 * so an on-disk database would be destroyed on every deploy). Rather than keep
 * two schema files in sync by hand — which drifts, silently, and is discovered
 * during an incident — this derives the one line that differs.
 *
 * Runs before `prisma generate`. Idempotent: if the provider already matches,
 * the file is not touched, so it does not show up as a spurious git change.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(root, 'prisma', 'schema.prisma');

/** Reads DATABASE_URL from the environment, falling back to .env. */
function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  try {
    const env = readFileSync(path.join(root, '.env'), 'utf8');
    const match = env.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

function providerFor(url) {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'postgresql';
  if (url.startsWith('mysql://')) return 'mysql';
  if (url.startsWith('sqlserver://')) return 'sqlserver';
  return 'sqlite';
}

const url = databaseUrl();

if (!url) {
  // Failing the build here is deliberate. Carrying on would generate a client
  // for whatever provider happens to be in the file — almost certainly SQLite —
  // and the mismatch would only surface as a confusing connection error against
  // the production database, after a deploy that reported success.
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[prepare-db] DATABASE_URL is not set in a production build.\n' +
        '             Set it before building, or the generated Prisma client will\n' +
        '             target the wrong database engine. On Railway, add a\n' +
        '             PostgreSQL service and set DATABASE_URL=${{Postgres.DATABASE_URL}}.',
    );
    process.exit(1);
  }

  console.warn('[prepare-db] DATABASE_URL is not set — leaving the schema provider unchanged.');
  process.exit(0);
}

const provider = providerFor(url);
const schema = readFileSync(schemaPath, 'utf8');

// Only the provider line inside the `datasource db` block.
const pattern = /(datasource\s+db\s*\{[^}]*?provider\s*=\s*")([^"]+)(")/s;
const match = schema.match(pattern);

if (!match) {
  console.error('[prepare-db] Could not find the datasource provider in prisma/schema.prisma.');
  process.exit(1);
}

const current = match[2];

if (current === provider) {
  console.log(`[prepare-db] Provider already "${provider}" — no change.`);
  process.exit(0);
}

writeFileSync(schemaPath, schema.replace(pattern, `$1${provider}$3`), 'utf8');
console.log(`[prepare-db] Provider switched "${current}" -> "${provider}" (from DATABASE_URL).`);
