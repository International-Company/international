#!/usr/bin/env node
/**
 * Rehearses the production upgrade against a real PostgreSQL.
 *
 * The deploy this guards has failed twice, both times for the same reason: a
 * column could not be dropped while it held data. That condition exists only on
 * a database with history, so pushing a fresh schema locally would never find
 * it, and SQLite does not enforce the same thing. Production was where it
 * appeared, which is the one place it must not.
 *
 * So this builds the database the way production actually is — the chart of
 * accounts, the journal, the old transaction shape, rows that cannot survive the
 * new model — and then runs the real deploy sequence over it. What it asserts is
 * what an operator would care about: the deploy completes, the money is still
 * there, and what was thrown away was only what could not be kept.
 */

import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const run = (command, args) =>
  execFileSync(command, args, {
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  });

let failures = 0;
const check = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!condition) failures++;
};

async function tableExists(db, table) {
  const rows = await db.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1`,
    table,
  );
  return rows.length > 0;
}

async function columnExists(db, table, column) {
  const rows = await db.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    table,
    column,
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------

async function buildProductionShape(db) {
  console.log('\n== Building the database as production has it ==');

  // Start from the current schema, then put back everything the upgrade removes
  // and take away everything it adds.
  run('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss']);

  // --- What the reduction removes -----------------------------------------
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "accounts" (
      "id"            TEXT PRIMARY KEY,
      "code"          TEXT NOT NULL UNIQUE,
      "nameEn"        TEXT NOT NULL,
      "nameAr"        TEXT NOT NULL,
      "type"          TEXT NOT NULL,
      "kind"          TEXT NOT NULL DEFAULT 'INTERNAL',
      "currencyCode"  TEXT NOT NULL,
      "balance"       BIGINT NOT NULL DEFAULT 0,
      "allowNegative" BOOLEAN NOT NULL DEFAULT false,
      "isActive"      BOOLEAN NOT NULL DEFAULT true,
      "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "journal_entries" (
      "id" TEXT PRIMARY KEY, "reference" TEXT NOT NULL UNIQUE,
      "description" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "journal_lines" (
      "id" TEXT PRIMARY KEY,
      "entryId" TEXT NOT NULL REFERENCES "journal_entries"("id") ON DELETE CASCADE,
      "accountId" TEXT NOT NULL REFERENCES "accounts"("id"),
      "debit" BIGINT NOT NULL DEFAULT 0, "credit" BIGINT NOT NULL DEFAULT 0
    );
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "day_closing_lines" (
      "id" TEXT PRIMARY KEY, "businessDayId" TEXT NOT NULL,
      "accountId" TEXT NOT NULL REFERENCES "accounts"("id"),
      "difference" BIGINT NOT NULL DEFAULT 0
    );
  `);
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "customer_balances" (
      "customerId" TEXT NOT NULL, "currencyCode" TEXT NOT NULL,
      "balance" BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY ("customerId", "currencyCode")
    );
  `);

  await db.$executeRawUnsafe(`
    ALTER TABLE "transactions"
      ADD COLUMN IF NOT EXISTS "channel" TEXT NOT NULL DEFAULT 'COUNTER',
      ADD COLUMN IF NOT EXISTS "feeCurrency" TEXT,
      ADD COLUMN IF NOT EXISTS "feeAmount" BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "sourceAccountId" TEXT,
      ADD COLUMN IF NOT EXISTS "destinationAccountId" TEXT,
      ADD COLUMN IF NOT EXISTS "counterpartyDoc" TEXT,
      ADD COLUMN IF NOT EXISTS "internalNotes" TEXT,
      ADD COLUMN IF NOT EXISTS "metadata" TEXT,
      ADD COLUMN IF NOT EXISTS "cancelReason" TEXT,
      ADD COLUMN IF NOT EXISTS "postedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "valueDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
  `);
  await db.$executeRawUnsafe(`ALTER TABLE "transactions" DROP COLUMN IF EXISTS "reverseReason";`);

  await db.$executeRawUnsafe(`ALTER TABLE "wallets" ADD COLUMN IF NOT EXISTS "accountId" TEXT;`);
  await db.$executeRawUnsafe(`ALTER TABLE "wallets" DROP COLUMN IF EXISTS "drawerId";`);

  // --- What the reduction adds must be absent ------------------------------
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "drawer_movements";`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "drawers";`);

  // --- Rows -----------------------------------------------------------------
  const branch = await db.branch.create({ data: { code: 'RH', nameEn: 'Rehearsal', nameAr: 'بروفة' } });
  const user = await db.user.create({
    data: {
      username: 'rehearsal', email: 'rehearsal@ifms.local',
      fullNameEn: 'Rehearsal', fullNameAr: 'بروفة', passwordHash: 'x', isSystem: true,
    },
  });
  for (const code of ['ILS', 'USD', 'JOD', 'USDT']) {
    await db.currency.upsert({
      where: { code },
      create: { code, nameEn: code, nameAr: code, symbol: code, decimals: 2, kind: code === 'USDT' ? 'CRYPTO' : 'FIAT' },
      update: {},
    });
  }

  // Money the branch holds, spread over the account kinds the old chart used.
  const accounts = [
    ['CASH-ILS', 'CASH', 'ILS', 200000_00000000n],
    ['BANK-ILS', 'BROKER', 'ILS', 50000_00000000n],
    ['CASH-USD', 'CASH', 'USD', 20000_00000000n],
    ['CRYPTO-USDT', 'CRYPTO', 'USDT', 500_00000000n],
    // Bookkeeping devices, which must NOT be carried into a drawer.
    ['FXPOS-ILS', 'INTERNAL', 'ILS', -9999_00000000n],
    ['INC-FX-ILS', 'INTERNAL', 'ILS', 7777_00000000n],
  ];
  for (const [code, kind, currency, balance] of accounts) {
    await db.$executeRawUnsafe(
      `INSERT INTO "accounts" ("id","code","nameEn","nameAr","type","kind","currencyCode","balance")
       VALUES ($1,$2,$3,$3,'ASSET',$4,$5,$6) ON CONFLICT ("code") DO NOTHING`,
      `acct-${code}`, code, code, kind, currency, balance,
    );
  }

  const insertTransaction = (id, reference, type, status, extra = {}) =>
    db.$executeRawUnsafe(
      `INSERT INTO "transactions"
         ("id","reference","type","status","channel","branchId","fromCurrency","fromAmount",
          "toCurrency","toAmount","rate","feeAmount","profitAmount","createdById",
          "cancelReason","valueDate","createdAt","updatedAt","version")
       VALUES ($1,$2,$3,$4,'COUNTER',$5,'USD',100000000,'ILS',370000000,370000000,0,0,$6,
               $7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,1)`,
      id, reference, type, status, branch.id, user.id, extra.cancelReason ?? null,
    );

  // Two that survive the reduction, three that cannot.
  await insertTransaction('t-keep-1', 'TXN-KEEP-1', 'EXCHANGE', 'POSTED');
  await insertTransaction('t-keep-2', 'TXN-KEEP-2', 'USDT_RECEIVE', 'POSTED');
  await insertTransaction('t-drop-1', 'TXN-DROP-1', 'CASH_IN', 'POSTED');
  await insertTransaction('t-drop-2', 'TXN-DROP-2', 'ADJUSTMENT', 'POSTED');
  await insertTransaction('t-drop-3', 'TXN-DROP-3', 'EXCHANGE', 'DRAFT', {
    cancelReason: 'customer changed their mind',
  });

  // A receipt hanging off one that must go, to prove the links are cleared
  // before the row is removed rather than tripping over a foreign key.
  await db.$executeRawUnsafe(
    `INSERT INTO "receipts" ("id","transactionId","number","createdAt")
     VALUES ('r-1','t-drop-1','RCP-1',CURRENT_TIMESTAMP)`,
  );

  check('the chart of accounts is present', await tableExists(db, 'accounts'));
  check('the journal is present', await tableExists(db, 'journal_lines'));
  check('drawers are absent', !(await tableExists(db, 'drawers')));
  check('wallets carry an account link', await columnExists(db, 'wallets', 'accountId'));
}

// ---------------------------------------------------------------------------

async function verify(db) {
  console.log('\n== Verifying the result ==');

  check('the chart of accounts is gone', !(await tableExists(db, 'accounts')));
  check('the journal is gone', !(await tableExists(db, 'journal_lines')));
  check('journal entries are gone', !(await tableExists(db, 'journal_entries')));
  check('the count sheet is gone', !(await tableExists(db, 'day_closing_lines')));
  check('customer balances are gone', !(await tableExists(db, 'customer_balances')));

  for (const column of ['channel', 'feeAmount', 'sourceAccountId', 'metadata', 'version', 'valueDate']) {
    check(`transactions.${column} dropped`, !(await columnExists(db, 'transactions', column)));
  }
  check('wallets.accountId dropped', !(await columnExists(db, 'wallets', 'accountId')));
  check('wallets.drawerId created', await columnExists(db, 'wallets', 'drawerId'));

  // The money.
  const drawers = await db.drawer.findMany({ orderBy: { currencyCode: 'asc' } });
  const cash = drawers.filter((d) => d.kind === 'CASH');
  const held = Object.fromEntries(cash.map((d) => [d.currencyCode, d.balance]));
  for (const [code, expected] of [
    // Cash and bank in the same currency are one drawer now.
    ['ILS', 250000_00000000n],
    ['USD', 20000_00000000n],
    ['USDT', 500_00000000n],
  ]) {
    check(`the ${code} cash drawer holds what the branch held`, held[code] === expected,
      `${held[code] ?? 'missing'} vs ${expected}`);
  }
  check('clearing and income were not turned into money', (held.ILS ?? 0n) === 250000_00000000n);

  // Every carried balance is explained by a movement, not merely asserted.
  const movements = await db.drawerMovement.count();
  check('each carried balance arrived with a movement', movements === 3, `${movements} movement(s)`);
  check('the seeder can still name them properly later', drawers.every((d) => d.nameEn.length > 0));

  // The bank side is new, and must arrive empty. A carried balance landing in a
  // bank row would be money invented by the migration.
  const bank = drawers.filter((d) => d.kind === 'BROKER');
  check('a bank balance was opened for each cash currency', bank.length === 3, `${bank.length}`);
  check('the bank balances start at zero', bank.every((d) => d.balance === 0n));
  check('USDT got no bank balance', !bank.some((d) => d.currencyCode === 'USDT'));
  check('nothing moved into a bank balance',
    (await db.drawerMovement.count({ where: { drawerId: { in: bank.map((d) => d.id) } } })) === 0);

  // What could not be kept, and what had to be.
  const kept = await db.transaction.findMany({ select: { reference: true }, orderBy: { reference: 'asc' } });
  check('transactions with no place were removed', kept.length === 2,
    kept.map((t) => t.reference).join(', ') || 'none');
  check('the ones that fit survived',
    kept[0]?.reference === 'TXN-KEEP-1' && kept[1]?.reference === 'TXN-KEEP-2');

  check('the staging table was drained and removed', !(await tableExists(db, '_ifms_drawer_carryover')));

  const receipts = await db.receipt.count();
  check('a receipt for a removed transaction went with it', receipts === 0);

}

// ---------------------------------------------------------------------------

/**
 * The wreckage an aborted attempt leaves behind.
 *
 * A superseded version of this migration staged the balances in a table of its
 * own and then failed at the push — after its earlier steps had already dropped
 * the accounts those figures came from. Production sat in exactly this state:
 * no chart of accounts, no drawers worth anything, and the only surviving copy
 * of the money in a table Prisma refuses to drop because it is not empty.
 *
 * A migration is not finished when it works on a clean database. It is finished
 * when it works on the mess its own earlier attempt made.
 */
async function simulateAbortedAttempt(db) {
  console.log('\n== Leaving the wreckage of an aborted attempt ==');

  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_ifms_drawer_carryover" (
      "currencyCode" TEXT PRIMARY KEY,
      "balance"      BIGINT NOT NULL
    );
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "_ifms_drawer_carryover" ("currencyCode", "balance")
    SELECT "currencyCode", SUM("balance")
      FROM "accounts"
     WHERE "kind" IN ('CASH', 'BROKER', 'CRYPTO')
     GROUP BY "currencyCode"
    ON CONFLICT ("currencyCode") DO NOTHING;
  `);
  // The step that ran before the push failed, taking the source of truth with it.
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "journal_lines";`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "day_closing_lines";`);
  await db.$executeRawUnsafe(`ALTER TABLE "wallets" DROP COLUMN IF EXISTS "accountId";`);
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "accounts";`);

  const [{ count }] = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS count FROM "_ifms_drawer_carryover"`,
  );
  check('the money survives only in the staging table', count === 3, `${count} row(s)`);
  check('the accounts it came from are gone', !(await tableExists(db, 'accounts')));
}

async function main() {
  const build = new PrismaClient();
  await buildProductionShape(build);
  await simulateAbortedAttempt(build);
  await build.$disconnect();

  console.log('\n== Running the deploy sequence ==');
  run('node', ['scripts/pre-deploy-schema.mjs']);
  // No --accept-data-loss, deliberately: if the reconciliation missed anything,
  // this is where the real deploy stopped, and it must stop here too.
  run('npx', ['prisma', 'db', 'push', '--skip-generate']);
  run('node', ['scripts/post-deploy-data.mjs']);

  const after = new PrismaClient();
  await verify(after);

  console.log('\n== Running it again (deploys repeat) ==');
  run('node', ['scripts/pre-deploy-schema.mjs']);
  run('npx', ['prisma', 'db', 'push', '--skip-generate']);
  run('node', ['scripts/post-deploy-data.mjs']);

  const drawers = await after.drawer.findMany();
  const ils = drawers.find((d) => d.currencyCode === 'ILS' && d.kind === 'CASH');
  check('idempotent — the balance did not move', ils?.balance === 250000_00000000n,
    String(ils?.balance));
  check('idempotent — no duplicate drawers', drawers.length === 6, `${drawers.length}`);

  await after.$disconnect();

  console.log(failures ? `\nREHEARSAL FAILED — ${failures} check(s)\n` : '\nRehearsal passed — the upgrade applies cleanly.\n');
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error('\nRehearsal error:\n', error);
  process.exit(1);
});
