#!/usr/bin/env node
/**
 * Intended destructive schema changes, written down.
 *
 * `prisma db push` refuses to drop a column that holds data, and it is right to.
 * The blunt fix is `--accept-data-loss` on every deploy, but that disarms the
 * guard permanently: a future column rename would then silently destroy a
 * production column on deploy, discovered — if ever — during an incident. In a
 * system whose whole purpose is a ledger, that trade is not worth making.
 *
 * So each destructive change is stated here instead, explicitly and once. What
 * is written here has been reviewed in a diff; anything *not* written here still
 * stops the deploy, which is exactly the behaviour worth keeping.
 *
 * Every statement is idempotent. This runs on every deploy, against databases in
 * any state — freshly created, already migrated, or several versions behind —
 * and must be a no-op in all of them.
 *
 * PostgreSQL only. Local development runs on SQLite and rebuilds freely, so
 * there is nothing to preserve there.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(path.join(root, '.env'), 'utf8');
    return env.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)?.[1] ?? '';
  } catch {
    return '';
  }
}

/**
 * Each step is a single statement, named so the deploy log says what happened
 * rather than printing SQL at whoever is watching.
 */
const STEPS = [
  {
    name: 'Preserve cancellation reasons under their new name',
    // A rename rather than a drop-and-add: `db push` would see two unrelated
    // columns and throw the old one away, taking every recorded reason with it.
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'transactions' AND column_name = 'rejectionReason'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'transactions' AND column_name = 'cancelReason'
        ) THEN
          ALTER TABLE "transactions" RENAME COLUMN "rejectionReason" TO "cancelReason";
        END IF;
      END $$;
    `,
  },
  {
    name: 'Drop the approval columns from transactions',
    // The approval workflow was removed in 34e24b8. These columns describe a
    // step that no longer exists; the actions themselves remain in the audit
    // chain, which is the record that matters.
    sql: `
      ALTER TABLE "transactions"
        DROP COLUMN IF EXISTS "requiresApproval",
        DROP COLUMN IF EXISTS "approvedById",
        DROP COLUMN IF EXISTS "approvedAt",
        DROP COLUMN IF EXISTS "rejectedById",
        DROP COLUMN IF EXISTS "rejectedAt",
        DROP COLUMN IF EXISTS "rejectionReason";
    `,
  },
  {
    name: 'Drop the approval trail table',
    sql: `DROP TABLE IF EXISTS "transaction_approvals";`,
  },

  // -------------------------------------------------------------------------
  // The reduction to two counter tools (6c64b60).
  //
  // The double-entry ledger and the chart of accounts are replaced by four
  // drawers. What the branch physically holds must survive that, so it is
  // carried across before anything is dropped — into a table Prisma does not
  // know about, because the drawers themselves do not exist until `db push`
  // has run. `post-deploy-data.mjs` reads it on the other side.
  // -------------------------------------------------------------------------
  {
    name: 'Carry the cash and crypto balances into drawers',
    // The drawers are created here rather than waiting for `db push`, because
    // the balances have to be written before the accounts holding them are
    // dropped and there is nowhere else to put them. A staging table is not an
    // option: `db push` deletes tables the schema does not describe, which it
    // proved by deleting the first version of this.
    //
    // `db push` then finds the table already in its final shape and has nothing
    // destructive to do to it.
    sql: `
      DO $$
      BEGIN
        CREATE TABLE IF NOT EXISTS "drawers" (
          "id"                  TEXT PRIMARY KEY,
          "currencyCode"        TEXT NOT NULL UNIQUE,
          "nameEn"              TEXT NOT NULL,
          "nameAr"              TEXT NOT NULL,
          "balance"             BIGINT NOT NULL DEFAULT 0,
          "allowNegative"       BOOLEAN NOT NULL DEFAULT false,
          "lowBalanceThreshold" BIGINT NOT NULL DEFAULT 0,
          "isActive"            BOOLEAN NOT NULL DEFAULT true,
          "sortOrder"           INTEGER NOT NULL DEFAULT 0,
          "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'accounts'
        ) THEN
          -- Only what the branch physically holds. Clearing, income, expense and
          -- equity accounts were devices for a ledger that is gone; carrying
          -- them would invent money the branch never had.
          INSERT INTO "drawers" ("id", "currencyCode", "nameEn", "nameAr", "balance")
          SELECT
            'drw-' || "currencyCode",
            "currencyCode",
            "currencyCode" || ' drawer',
            'صندوق ' || "currencyCode",
            SUM("balance")
          FROM "accounts"
          WHERE "kind" IN ('CASH', 'BANK', 'CRYPTO')
          GROUP BY "currencyCode"
          ON CONFLICT ("currencyCode") DO NOTHING;
        END IF;
      END $$;
    `,
  },
  {
    name: 'Relink monitored wallets to their drawer',
    // The column is added empty here so `db push` has nothing to add and the
    // post-deploy step can fill it once the drawers exist.
    sql: `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'wallets'
        ) THEN
          ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "drawerId" TEXT;
          ALTER TABLE "wallets" DROP COLUMN IF EXISTS "accountId";
        END IF;
      END $$;
    `,
  },
  {
    name: 'Remove transactions the reduced model cannot express',
    // The ten transaction types became two, and the four statuses became two.
    // A cash-in or an abandoned draft has no representation now: it would sit
    // in the table with a type nothing reads and a status nothing can act on.
    // Deleting is honest where keeping would be a fiction — and the audit chain
    // still records that each of them happened.
    sql: `
      DO $$
      DECLARE removed INTEGER;
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'transactions'
        ) THEN
          DELETE FROM "receipts"
           WHERE "transactionId" IN (
             SELECT "id" FROM "transactions"
              WHERE "type" NOT IN ('EXCHANGE', 'USDT_RECEIVE')
                 OR "status" NOT IN ('POSTED', 'REVERSED')
           );

          UPDATE "usdt_deposit_requests" SET "transactionId" = NULL
           WHERE "transactionId" IN (
             SELECT "id" FROM "transactions"
              WHERE "type" NOT IN ('EXCHANGE', 'USDT_RECEIVE')
                 OR "status" NOT IN ('POSTED', 'REVERSED')
           );

          UPDATE "chain_transactions" SET "linkedTransactionId" = NULL
           WHERE "linkedTransactionId" IN (
             SELECT "id" FROM "transactions"
              WHERE "type" NOT IN ('EXCHANGE', 'USDT_RECEIVE')
                 OR "status" NOT IN ('POSTED', 'REVERSED')
           );

          -- A reversal points at its original; clear the link before either end
          -- can be removed, so neither deletion trips over the other.
          UPDATE "transactions" SET "reversalOfId" = NULL
           WHERE "reversalOfId" IN (
             SELECT "id" FROM "transactions"
              WHERE "type" NOT IN ('EXCHANGE', 'USDT_RECEIVE')
                 OR "status" NOT IN ('POSTED', 'REVERSED')
           );

          DELETE FROM "transactions"
           WHERE "type" NOT IN ('EXCHANGE', 'USDT_RECEIVE')
              OR "status" NOT IN ('POSTED', 'REVERSED');

          GET DIAGNOSTICS removed = ROW_COUNT;
          IF removed > 0 THEN
            RAISE NOTICE 'removed % transaction(s) with no place in the reduced model', removed;
          END IF;
        END IF;
      END $$;
    `,
  },
  {
    name: 'Drop the transaction columns the reduced model has no use for',
    sql: `
      ALTER TABLE "transactions"
        DROP COLUMN IF EXISTS "channel",
        DROP COLUMN IF EXISTS "feeCurrency",
        DROP COLUMN IF EXISTS "feeAmount",
        DROP COLUMN IF EXISTS "sourceAccountId",
        DROP COLUMN IF EXISTS "destinationAccountId",
        DROP COLUMN IF EXISTS "counterpartyDoc",
        DROP COLUMN IF EXISTS "internalNotes",
        DROP COLUMN IF EXISTS "metadata",
        DROP COLUMN IF EXISTS "cancelReason",
        DROP COLUMN IF EXISTS "postedAt",
        DROP COLUMN IF EXISTS "valueDate",
        DROP COLUMN IF EXISTS "version";
    `,
  },
  {
    name: 'Drop the ledger',
    // Order matters: lines before entries, and both before the accounts they
    // point at.
    sql: `
      DROP TABLE IF EXISTS "journal_lines";
    `,
  },
  { name: 'Drop the journal', sql: `DROP TABLE IF EXISTS "journal_entries";` },
  { name: 'Drop the daily count sheet', sql: `DROP TABLE IF EXISTS "day_closing_lines";` },
  { name: 'Drop customer balances', sql: `DROP TABLE IF EXISTS "customer_balances";` },
  { name: 'Drop the chart of accounts', sql: `DROP TABLE IF EXISTS "accounts";` },
];

/** Host and database only — a connection string in a deploy log is a leak. */
function describe(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch {
    return 'the configured server';
  }
}

async function main() {
  const url = databaseUrl();

  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    console.log('[pre-deploy] Not PostgreSQL — nothing to do.');
    return;
  }

  // Printed before connecting, so the log shows what was decided even when the
  // connection is what fails.
  console.log(`[pre-deploy] PostgreSQL at ${describe(url)} — reconciling intended changes.`);

  const prisma = new PrismaClient();

  try {
    // Nothing to reconcile on a database that has no tables yet; `db push` will
    // create everything in its final shape.
    const [{ exists }] = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'transactions'
       ) AS exists`,
    );

    if (!exists) {
      console.log('[pre-deploy] Fresh database — nothing to reconcile.');
      return;
    }

    for (const step of STEPS) {
      await prisma.$executeRawUnsafe(step.sql);
      console.log(`[pre-deploy] ${step.name}`);
    }

    console.log(`[pre-deploy] ${STEPS.length} step(s) applied.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // An unreachable database is the ordinary cause and deserves a sentence, not a
  // stack trace — it is nearly always a missing or wrong DATABASE_URL.
  if (error?.errorCode === 'P1001' || /Can't reach database server/i.test(String(error?.message))) {
    console.error(
      `\n[pre-deploy] Cannot reach the database at ${describe(databaseUrl())}.\n` +
        '             Check DATABASE_URL and that the database service is running.\n',
    );
    process.exit(1);
  }

  // Anything else is loud, and fatal. A half-reconciled schema followed by a
  // successful push would be worse than a failed deploy: the application would
  // start, against a shape nobody intended.
  console.error('\n[pre-deploy] Failed to reconcile the schema:\n', error);
  process.exit(1);
});
