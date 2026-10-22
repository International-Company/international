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
  // carried across before anything is dropped. The movement that explains each
  // carried balance is written afterwards, by post-deploy-data.mjs, once the
  // table that holds movements exists.
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

        IF to_regclass('"accounts"') IS NOT NULL THEN
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
          WHERE "kind" IN ('CASH', 'BROKER', 'CRYPTO')
          GROUP BY "currencyCode"
          ON CONFLICT ("currencyCode") DO NOTHING;
        END IF;

        -- An earlier version of this migration staged the balances in a table
        -- of its own, then failed at the push — which left that table behind,
        -- holding the only remaining copy of the figures, because the same run
        -- had already dropped the accounts they came from.
        --
        -- So it is drained rather than dropped. The update only fires on a
        -- drawer still sitting at zero: one that has been traded through since
        -- holds the truth, and a figure from a superseded attempt must not
        -- overwrite it.
        IF to_regclass('"_ifms_drawer_carryover"') IS NOT NULL THEN
          INSERT INTO "drawers" ("id", "currencyCode", "nameEn", "nameAr", "balance")
          SELECT
            'drw-' || "currencyCode",
            "currencyCode",
            "currencyCode" || ' drawer',
            'صندوق ' || "currencyCode",
            "balance"
          FROM "_ifms_drawer_carryover"
          ON CONFLICT ("currencyCode") DO UPDATE
            SET "balance" = EXCLUDED."balance"
            WHERE "drawers"."balance" = 0;

          DROP TABLE "_ifms_drawer_carryover";
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
        IF to_regclass('"wallets"') IS NOT NULL THEN
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
    // Every table it touches is checked for first. This script has to be safe on
    // a database in any state — several versions behind, or one where a feature
    // was never deployed — and a reference to a table that is not there yet
    // would abort the block and stop the deploy on something unrelated.
    sql: `
      DO $$
      DECLARE doomed TEXT[];
      BEGIN
        IF to_regclass('"transactions"') IS NULL THEN RETURN; END IF;

        -- Held in an array rather than a temp table: a temp table's lifetime is
        -- the session's, and a pooled connection could hand the next run one
        -- that already exists.
        -- Named, never "anything not in today's list". This runs on every
        -- deploy, and the negative form deleted every remittance, every USDT
        -- send and every transfer awaiting confirmation on each one, from the
        -- day those were added (10 August) — because they were not in the list
        -- of the day this was written. Only the vocabulary that was actually
        -- retired in 6c64b60 is removed, so nothing added later can match.
        SELECT array_agg("id") INTO doomed
          FROM "transactions"
         WHERE "type" IN (
                 'CASH_IN', 'CASH_OUT', 'TRANSFER_IN', 'TRANSFER_OUT',
                 'DEPOSIT', 'WITHDRAWAL', 'USDT_IN', 'USDT_OUT', 'ADJUSTMENT'
               )
            OR "status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED');

        IF doomed IS NULL THEN RETURN; END IF;

        IF to_regclass('"receipts"') IS NOT NULL THEN
          DELETE FROM "receipts" WHERE "transactionId" = ANY(doomed);
        END IF;

        IF to_regclass('"usdt_deposit_requests"') IS NOT NULL THEN
          UPDATE "usdt_deposit_requests" SET "transactionId" = NULL
           WHERE "transactionId" = ANY(doomed);
        END IF;

        IF to_regclass('"chain_transactions"') IS NOT NULL THEN
          UPDATE "chain_transactions" SET "linkedTransactionId" = NULL
           WHERE "linkedTransactionId" = ANY(doomed);
        END IF;

        -- A reversal points at its original; clear the link before either end
        -- can be removed, so neither deletion trips over the other.
        UPDATE "transactions" SET "reversalOfId" = NULL WHERE "reversalOfId" = ANY(doomed);

        DELETE FROM "transactions" WHERE "id" = ANY(doomed);

        RAISE NOTICE 'removed % transaction(s) with no place in the reduced model',
          array_length(doomed, 1);
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

  /*
   * A currency can now be held in two places: the till and the bank.
   *
   * `db push` cannot make this change on its own. Adding `kind` is fine, but the
   * old single-column unique index on `currencyCode` would reject the second row
   * for a currency, and push would either fail or offer to drop data. So the
   * column is added, the old index retired and the composite one created here,
   * before push ever looks at the table.
   *
   * Every existing row is cash — that is what a drawer meant until now — and the
   * default says so, so nothing has to be guessed per row.
   */
  {
    name: 'Give drawers a kind, and let a currency have two',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('public.drawers') IS NULL THEN
          RETURN;
        END IF;

        ALTER TABLE "drawers" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'CASH';

        -- Once a drawer has an owner, the key below is not merely obsolete —
        -- it is unbuildable: two tellers holding shekels are two rows with the
        -- same currency and kind, which is the whole point of the newer key.
        -- So everything in this step belongs to the world before ownership.
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'drawers'
            AND column_name = 'ownerKey'
        ) THEN
          RETURN;
        END IF;

        -- Prisma names this from the model, but a hand-made database may differ;
        -- drop whatever single-column unique index is actually on currencyCode.
        PERFORM 1;
        EXECUTE (
          SELECT COALESCE(
            string_agg(format('ALTER TABLE "drawers" DROP CONSTRAINT %I;', conname), ' '),
            'SELECT 1;'
          )
          FROM pg_constraint
          WHERE conrelid = 'public.drawers'::regclass
            AND contype = 'u'
            AND array_length(conkey, 1) = 1
            AND conkey[1] = (
              SELECT attnum FROM pg_attribute
              WHERE attrelid = 'public.drawers'::regclass AND attname = 'currencyCode'
            )
        );

        DROP INDEX IF EXISTS "drawers_currencyCode_key";

        CREATE UNIQUE INDEX IF NOT EXISTS "drawers_currencyCode_kind_key"
          ON "drawers" ("currencyCode", "kind");
      END $$;
    `,
  },

  /*
   * What was called the bank is the broker.
   *
   * The office holds no account of its own: a broker moves everything through
   * his, and charges a different price for it. Naming it correctly is not
   * cosmetic — the whole reason it prices separately is that it is somebody
   * else's balance sheet.
   */
  {
    name: 'Rename the bank balance to what it is: the broker',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('public.drawers') IS NOT NULL THEN
          UPDATE "drawers" SET "kind" = 'BROKER' WHERE "kind" = 'BANK';
        END IF;
      END $$;
    `,
  },

  /*
   * The broker rows themselves, one per cash currency, at zero.
   *
   * Created here rather than left to the seed because the seed only runs after
   * push, and a manager opening the drawers screen on the first request after a
   * deploy should find the bank balances already there rather than a screen that
   * fills in later.
   *
   * USDT is excluded on purpose: it is held on a chain, not at a bank, and a row
   * for it would be a balance nobody could ever fund.
   */
  {
    name: 'Open a broker balance beside each cash drawer',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('public.drawers') IS NULL OR to_regclass('public.currencies') IS NULL THEN
          RETURN;
        END IF;

        -- Which key exists decides which conflict target is valid: an upsert
        -- needs a unique index on exactly the columns it names, and the drawers
        -- table has carried two different ones in its life.
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'drawers'
            AND column_name = 'ownerKey'
        ) THEN
        INSERT INTO "drawers" ("id", "ownerKey", "currencyCode", "kind", "nameEn", "nameAr", "balance", "sortOrder", "createdAt", "updatedAt")
          SELECT
            'drw_bank_' || lower(c."code"),
            'TREASURY',
            c."code",
            'BROKER',
            c."nameEn" || ' bank',
            'بنك ' || c."nameAr",
            0,
            c."sortOrder" * 10 + 1,
            NOW(),
            NOW()
          FROM "currencies" c
          WHERE c."kind" <> 'CRYPTO'
          ON CONFLICT ("ownerKey", "currencyCode", "kind") DO NOTHING;
        ELSE
        INSERT INTO "drawers" ("id", "currencyCode", "kind", "nameEn", "nameAr", "balance", "sortOrder", "createdAt", "updatedAt")
          SELECT
            'drw_bank_' || lower(c."code"),
            c."code",
            'BROKER',
            c."nameEn" || ' bank',
            'بنك ' || c."nameAr",
            0,
            c."sortOrder" * 10 + 1,
            NOW(),
            NOW()
          FROM "currencies" c
          WHERE c."kind" <> 'CRYPTO'
          ON CONFLICT ("currencyCode", "kind") DO NOTHING;
        END IF;
      END $$;
    `,
  },

  /*
   * Every payout recorded so far was cash — that was the only thing a payout
   * could be — so say so on the row.
   *
   * Not cosmetic. A reversal returns the money to the balances the payout came
   * out of, and reads those two columns to know which. Left at zero, reversing
   * an old transaction would restore nothing to the till: the customer's money
   * would come back and the branch's would not. The service defends against
   * this too, but a correct column is better than a correct guess about a wrong
   * one.
   */
  {
    name: 'Record that every existing payout was cash',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('public.transactions') IS NULL THEN
          RETURN;
        END IF;

        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payoutCashAmount" BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payoutBankAmount" BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "transferConfirmedAt" TIMESTAMP(3);
        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "transferConfirmedById" TEXT;

        -- A remittance sent is excluded, and must be: its payout leaves the
        -- correspondent's balance, not the till, so its zeroes are deliberate.
        -- These steps run on every deploy, so without this the next one would
        -- quietly restate every outgoing transfer as a cash payout.
        UPDATE "transactions"
        SET "payoutCashAmount" = "toAmount"
        WHERE "payoutCashAmount" = 0 AND "payoutBankAmount" = 0 AND "toAmount" <> 0
          AND "type" <> 'REMITTANCE_OUT';

        -- Where a transfer was sent. Nothing to backfill: no transfer has ever
        -- been recorded without one, because the column arrives with the field.
        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payoutBankChannel" TEXT;

        -- Which of the broker's accounts a movement went through. Nothing to
        -- backfill: movements made before the column existed were instructed
        -- without one being recorded, and inventing a name here would be
        -- inventing evidence for a reconciliation.
        IF to_regclass('public.drawer_movements') IS NOT NULL THEN
          ALTER TABLE "drawer_movements" ADD COLUMN IF NOT EXISTS "account" TEXT;
        END IF;
      END $$;
    `,
  },

  /*
   * The correspondent's balance, one per cash currency.
   *
   * Opened negative-capable from the start. Sending a remittance means the
   * branch owes the correspondent until it settles, so this balance lives below
   * zero as a matter of course — it is a liability, not a till. Guarding it at
   * zero like a drawer would refuse the first transfer of every settlement
   * cycle, which is the ordinary case rather than the exception.
   *
   * USDT is excluded for the same reason as the broker rows: the correspondent
   * deals in notes.
   */
  {
    name: 'Open a correspondent balance beside each cash drawer',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('public.drawers') IS NULL OR to_regclass('public.currencies') IS NULL THEN
          RETURN;
        END IF;

        -- Which key exists decides which conflict target is valid: an upsert
        -- needs a unique index on exactly the columns it names, and the drawers
        -- table has carried two different ones in its life.
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'drawers'
            AND column_name = 'ownerKey'
        ) THEN
        INSERT INTO "drawers" ("id", "ownerKey", "currencyCode", "kind", "nameEn", "nameAr", "balance", "allowNegative", "sortOrder", "createdAt", "updatedAt")
          SELECT
            'drw_corr_' || lower(c."code"),
            'TREASURY',
            c."code",
            'CORRESPONDENT',
            c."nameEn" || ' — correspondent',
            'المراسل — ' || c."nameAr",
            0,
            true,
            c."sortOrder" * 10 + 2,
            NOW(),
            NOW()
          FROM "currencies" c
          WHERE c."kind" <> 'CRYPTO'
          ON CONFLICT ("ownerKey", "currencyCode", "kind") DO NOTHING;
        ELSE
        INSERT INTO "drawers" ("id", "currencyCode", "kind", "nameEn", "nameAr", "balance", "allowNegative", "sortOrder", "createdAt", "updatedAt")
          SELECT
            'drw_corr_' || lower(c."code"),
            c."code",
            'CORRESPONDENT',
            c."nameEn" || ' — correspondent',
            'المراسل — ' || c."nameAr",
            0,
            true,
            c."sortOrder" * 10 + 2,
            NOW(),
            NOW()
          FROM "currencies" c
          WHERE c."kind" <> 'CRYPTO'
          ON CONFLICT ("currencyCode", "kind") DO NOTHING;
        END IF;
      END $$;
    `,
  },

  /*
   * How the customer paid, recorded the way the payout already is.
   *
   * Every trade until now was paid for in notes — that was the only thing the
   * intake could be — so say so on the row rather than leaving zeroes. Not
   * cosmetic, and for exactly the reason the payout backfill was not: a
   * reversal returns the money to the balances it came from and reads these two
   * columns to know which. Left at zero, reversing an old transaction would
   * take nothing back out of the till.
   */
  {
    name: 'Record that every existing intake was cash',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('public.transactions') IS NULL THEN
          RETURN;
        END IF;

        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intakeCashAmount" BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intakeBrokerAmount" BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "intakeBankChannel" TEXT;

        UPDATE "transactions"
        SET "intakeCashAmount" = "fromAmount"
        -- A remittance received is excluded for the mirror reason: what came in
        -- was drawn on the correspondent, not counted into the till.
        WHERE "intakeCashAmount" = 0 AND "intakeBrokerAmount" = 0 AND "fromAmount" <> 0
          AND "type" <> 'REMITTANCE_IN';

        -- Where USDT was sent. Nothing to backfill: no withdrawal has ever been
        -- recorded, because the column arrives with the screen that records one.
        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payoutAddress" TEXT;
        ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "payoutWalletId" TEXT;
      END $$;
    `,
  },

  /*
   * Give every drawer an owner, and move its identity onto that owner.
   *
   * The office's money is about to live at two levels — the treasury, and one
   * drawer per teller — so a currency and a kind stop being enough to name a
   * drawer. Everything that exists today is the treasury's, and is marked so
   * before the key changes, or the new unique index would have nothing to
   * distinguish rows by.
   *
   * `db push` would do this on its own. It is written here because it is a
   * change of identity: the column the whole system looks a drawer up by. That
   * is worth stating explicitly and applying in a known order — mark first,
   * then swap the constraint — rather than leaving the order to a tool.
   */
  {
    name: 'Give every drawer an owner, and key it by that owner',
    sql: `
      DO $$
      BEGIN
        IF to_regclass('public.drawers') IS NULL THEN
          RETURN;
        END IF;

        ALTER TABLE "drawers" ADD COLUMN IF NOT EXISTS "ownerKey" TEXT NOT NULL DEFAULT 'TREASURY';
        ALTER TABLE "drawers" ADD COLUMN IF NOT EXISTS "tellerId" TEXT;

        -- Anything already there was the office's before there was anyone else
        -- to hold it.
        UPDATE "drawers" SET "ownerKey" = 'TREASURY' WHERE "ownerKey" IS NULL OR "ownerKey" = '';

        -- The old key allowed one drawer per currency and kind, which is
        -- exactly what two tellers holding shekels would violate.
        ALTER TABLE "drawers" DROP CONSTRAINT IF EXISTS "drawers_currencyCode_kind_key";
        DROP INDEX IF EXISTS "drawers_currencyCode_kind_key";

        CREATE UNIQUE INDEX IF NOT EXISTS "drawers_ownerKey_currencyCode_kind_key"
          ON "drawers" ("ownerKey", "currencyCode", "kind");

        CREATE INDEX IF NOT EXISTS "drawers_tellerId_idx" ON "drawers" ("tellerId");
      END $$;
    `,
  },
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
