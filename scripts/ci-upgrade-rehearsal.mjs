#!/usr/bin/env node
/**
 * Rehearses the production upgrade against a real PostgreSQL.
 *
 * The deploy that this guards failed because a column could not be dropped
 * while it held data — a condition that exists only on a database with history,
 * so no amount of pushing a fresh schema locally would ever have found it. SQLite
 * would not have found it either: it does not enforce the same thing.
 *
 * So this builds the database the way production actually was — the approval
 * columns present, populated, with the approval trail alongside — and then runs
 * the real deploy sequence over it. What it asserts is what an operator would
 * care about: the deploy completes, the obsolete columns are gone, the new ones
 * exist, and the one column that was renamed still holds its text rather than
 * having been quietly dropped and recreated empty.
 */

import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const run = (command, args) =>
  execFileSync(command, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });

const check = (label, condition) => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!condition) process.exitCode = 1;
};

async function columnExists(table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    table,
    column,
  );
  return rows.length > 0;
}

async function tableExists(table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1`,
    table,
  );
  return rows.length > 0;
}

async function main() {
  console.log('\n== Building the database as production had it ==');

  // The current schema, minus everything the upgrade is meant to remove — then
  // the removed things put back by hand, exactly as the old release left them.
  run('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss']);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "transactions"
      ADD COLUMN IF NOT EXISTS "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "approvedById" TEXT,
      ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "rejectedById" TEXT,
      ADD COLUMN IF NOT EXISTS "rejectedAt" TIMESTAMP(3);
  `);
  // The old name of the column the upgrade renames.
  await prisma.$executeRawUnsafe(`ALTER TABLE "transactions" DROP COLUMN IF EXISTS "cancelReason";`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;`);

  // Everything the release adds must also be absent, or the rehearsal would
  // only test half the upgrade and the additive half would go unexercised.
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "usdt_deposit_requests";`);
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "wallets"
      DROP COLUMN IF EXISTS "isCounterAddress",
      DROP COLUMN IF EXISTS "counterSortOrder";
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "transaction_approvals" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "transactionId" TEXT NOT NULL,
      "step" INTEGER NOT NULL DEFAULT 1,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "comment" TEXT,
      "actedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Rows that carry the data whose loss blocked the deploy.
  const branch = await prisma.branch.create({
    data: { code: 'RH', nameEn: 'Rehearsal', nameAr: 'بروفة' },
  });
  const user = await prisma.user.create({
    data: {
      username: 'rehearsal', email: 'rehearsal@ifms.local',
      fullNameEn: 'Rehearsal', fullNameAr: 'بروفة', passwordHash: 'x',
    },
  });

  for (const [reference, reason] of [
    ['TXN-REHEARSAL-1', 'customer changed their mind'],
    ['TXN-REHEARSAL-2', 'entered against the wrong customer'],
  ]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "transactions"
         ("id","reference","type","status","channel","branchId","fromCurrency","fromAmount",
          "toCurrency","toAmount","rate","feeAmount","profitAmount","createdById",
          "requiresApproval","rejectionReason","valueDate","createdAt","updatedAt","version")
       VALUES ($1,$2,'EXCHANGE','CANCELLED','COUNTER',$3,'USD',100000000,
          'ILS',370000000,370000000,0,0,$4,
          true,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      `rehearsal-${reference}`, reference, branch.id, user.id, reason,
    );
  }

  check('the old approval column is present and populated', await columnExists('transactions', 'requiresApproval'));
  check('the old reason column is present', await columnExists('transactions', 'rejectionReason'));
  check('the approval trail table is present', await tableExists('transaction_approvals'));

  await prisma.$disconnect();

  // ---------------------------------------------------------------------
  console.log('\n== Running the deploy sequence ==');

  run('node', ['scripts/pre-deploy-schema.mjs']);
  // No --accept-data-loss, deliberately: if the reconciliation missed anything,
  // this is where the real deploy stopped, and it must stop here too.
  run('npx', ['prisma', 'db', 'push', '--skip-generate']);

  // ---------------------------------------------------------------------
  console.log('\n== Verifying the result ==');

  const after = new PrismaClient();

  const gone = async (column) => {
    const rows = await after.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'transactions' AND column_name = $1`,
      column,
    );
    return rows.length === 0;
  };

  check('requiresApproval dropped', await gone('requiresApproval'));
  check('approvedById dropped', await gone('approvedById'));
  check('approvedAt dropped', await gone('approvedAt'));
  check('rejectedById dropped', await gone('rejectedById'));
  check('rejectedAt dropped', await gone('rejectedAt'));
  check('rejectionReason dropped', await gone('rejectionReason'));

  const trail = await after.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'transaction_approvals'`,
  );
  check('approval trail table dropped', trail.length === 0);

  const reasons = await after.$queryRawUnsafe(
    `SELECT "reference", "cancelReason" FROM "transactions" ORDER BY "reference"`,
  );
  check('both transactions survived', reasons.length === 2);
  check(
    'cancellation reasons carried across the rename',
    reasons[0]?.cancelReason === 'customer changed their mind' &&
      reasons[1]?.cancelReason === 'entered against the wrong customer',
  );
  for (const row of reasons) console.log(`         ${row.reference}: ${row.cancelReason}`);

  // The counter tools' table must exist afterwards, or the release is half-applied.
  const deposits = await after.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'usdt_deposit_requests'`,
  );
  check('usdt_deposit_requests created', deposits.length === 1);
  check('wallets carry isCounterAddress', await (async () => {
    const rows = await after.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'wallets' AND column_name = 'isCounterAddress'`,
    );
    return rows.length === 1;
  })());

  // Running it a second time must change nothing — deploys repeat.
  console.log('\n== Running it again (deploys repeat) ==');
  run('node', ['scripts/pre-deploy-schema.mjs']);
  run('npx', ['prisma', 'db', 'push', '--skip-generate']);
  const stillThere = await after.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "transactions"`);
  check('idempotent — transactions untouched', stillThere[0]?.n === 2);

  await after.$disconnect();

  console.log(process.exitCode ? '\nREHEARSAL FAILED\n' : '\nRehearsal passed — the upgrade applies cleanly.\n');
}

main().catch(async (error) => {
  console.error('\nRehearsal error:\n', error);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
