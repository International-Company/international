#!/usr/bin/env node
/**
 * Erases every operational record while keeping the installation configured.
 *
 * Intended for exactly one moment: going live, after the system has been
 * exercised with test data. It removes transactions, journal entries, customers,
 * wallets, rates, business days, notifications, jobs and the audit trail, then
 * resets every account balance to zero. It keeps the branch, currencies, chart
 * of accounts, permissions, roles, users and settings.
 *
 * This is destructive and irreversible, so it refuses to run without explicit
 * confirmation:
 *
 *   npm run db:clear-operational -- --confirm
 *
 * A note on the audit trail. It is append-only and hash-chained by design, and
 * nothing in the application can edit or delete it — that property is the point.
 * This script is outside the application and deletes the whole table rather than
 * altering rows, so the chain restarts cleanly from genesis instead of being
 * left broken. Clearing part of it would be far worse than clearing all of it.
 */

import { PrismaClient } from '@prisma/client';
import readline from 'node:readline/promises';

const prisma = new PrismaClient();

/**
 * Deletion order matters: children before parents. Transactions are cleared in
 * two passes because a reversal points at the transaction it reverses.
 */
const OPERATIONAL_TABLES = [
  'usdtDepositRequest',
  'journalLine',
  'journalEntry',
  'dayClosingLine',
  'receipt',
  'chainTransaction',
  'walletSnapshot',
  'walletSyncRun',
  'notificationRecipient',
  'notification',
  'customerDocument',
  'customerBalance',
  'draft',
  'job',
  'loginAttempt',
  'auditLog',
  'restoreRun',
  'backup',
];

async function confirm() {
  if (process.argv.includes('--confirm') || process.env.CONFIRM_CLEAR === 'yes') return true;

  if (!process.stdin.isTTY) {
    console.error(
      'Refusing to run without confirmation.\n' +
        'Re-run with:  npm run db:clear-operational -- --confirm',
    );
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    'This permanently deletes all transactions, customers, rates and the audit trail.\n' +
      'Type CLEAR to proceed: ',
  );
  rl.close();
  return answer.trim() === 'CLEAR';
}

async function main() {
  if (!(await confirm())) {
    console.log('Cancelled — nothing was changed.');
    return;
  }

  console.log('\n▶ Clearing operational data…\n');

  // Break the self-reference before deleting, so neither row blocks the other.
  await prisma.transaction.updateMany({ data: { reversalOfId: null } });
  await prisma.chainTransaction.updateMany({ data: { linkedTransactionId: null } });

  let total = 0;

  for (const table of OPERATIONAL_TABLES) {
    const delegate = prisma[table];
    const { count } = await delegate.deleteMany();
    if (count > 0) console.log(`  ${table.padEnd(24)} ${count}`);
    total += count;
  }

  for (const table of ['transaction', 'businessDay', 'customer', 'wallet', 'exchangeRate']) {
    const { count } = await prisma[table].deleteMany();
    if (count > 0) console.log(`  ${table.padEnd(24)} ${count}`);
    total += count;
  }

  // Reference counters restart, so the first real transaction is number one.
  const { count: sequences } = await prisma.sequence.deleteMany();
  if (sequences > 0) console.log(`  ${'sequence'.padEnd(24)} ${sequences}`);
  total += sequences;

  // Every balance is derived from journal lines, and there are none left.
  const { count: accounts } = await prisma.account.updateMany({ data: { balance: 0n } });
  console.log(`  ${'account balances reset'.padEnd(24)} ${accounts}`);

  // Sessions are invalidated so nobody keeps operating against a cleared system.
  const { count: sessions } = await prisma.session.deleteMany();
  if (sessions > 0) console.log(`  ${'sessions revoked'.padEnd(24)} ${sessions}`);

  console.log(`\n✔ Removed ${total} operational record(s). Configuration kept.`);
  console.log('  Publish rates and enter opening balances before trading.\n');
}

main()
  .catch((error) => {
    console.error('\n✖ Failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
