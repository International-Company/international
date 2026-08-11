/**
 * Sets a user's password from the command line, against the live database.
 *
 * This exists because the system had no way back in. There is one manager, the
 * sign-in screen tells them to "contact your system administrator", and they
 * are the system administrator — so a forgotten password, or five wrong
 * attempts, locked the owner out of their own books with no recourse but a
 * database client and a hand-written hash.
 *
 * Deliberately not a screen and not an endpoint. Anything reachable over the
 * network that resets a password is a way in for whoever finds it; this needs
 * the database URL, which is to say it needs the keys to everything already.
 *
 * It imports the application's own hashing and its own audit service rather
 * than reimplementing either. The first version of this did reimplement them,
 * and would have written a chain entry with the wrong field names — breaking
 * the very verification the chain exists for.
 *
 *   npx tsx --conditions=react-server scripts/reset-password.mts <username> [password]
 *
 * With no password given it generates one and prints it once.
 */

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { prisma } from '../src/core/db/prisma';
import { hashPassword } from '../src/core/security/scrypt';
import * as audit from '../src/modules/audit/audit.service';

/** Readable, and long enough that printing it once is not a compromise. */
function suggestPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const picked = [...randomBytes(20)].map((byte) => alphabet[byte % alphabet.length]).join('');
  return `${picked.slice(0, 5)}-${picked.slice(5, 10)}-${picked.slice(10, 15)}-${picked.slice(15)}!`;
}

const [username, given] = process.argv.slice(2);

if (!username) {
  console.error('\n  Usage: npx tsx --conditions=react-server scripts/reset-password.mts <username> [password]\n');
  process.exit(1);
}

const user = await prisma.user.findFirst({
  where: { OR: [{ username }, { email: username }] },
});

if (!user) {
  console.error(`\n  No user "${username}".\n`);
  await prisma.$disconnect();
  process.exit(1);
}

const password = given ?? suggestPassword();
if (password.length < 12) {
  console.error('\n  Too short — use at least 12 characters.\n');
  await prisma.$disconnect();
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const who = (await rl.question('  Who is doing this (for the audit log)? ')).trim() || 'command line';
rl.close();

await prisma.user.update({
  where: { id: user.id },
  data: {
    passwordHash: await hashPassword(password),
    passwordUpdatedAt: new Date(),
    // Unlocked, and the failed count cleared: being locked out is the usual
    // reason anyone reaches for this.
    failedLoginCount: 0,
    lockedUntil: null,
    status: user.status === 'LOCKED' ? 'ACTIVE' : user.status,
    /*
     * Not forced to change it again. Whoever ran this chose the password they
     * are about to hand over, and a forced change on top means a second one
     * invented at the counter — which is how "Teller123" happens.
     */
    mustChangePassword: false,
  },
});

await audit.record({
  action: 'PASSWORD_RESET',
  module: 'auth',
  entityType: 'User',
  entityId: user.id,
  summaryEn: `Password reset from the command line for ${user.username} by ${who}`,
  summaryAr: `إعادة تعيين كلمة مرور ${user.username} من سطر الأوامر بواسطة ${who}`,
  actor: { name: who },
});

console.log(`\n  Password set for ${user.username}.`);
if (!given) console.log(`\n      ${password}\n`);
console.log('  Shown once. Sign in with it, then change it from the profile screen.\n');

await prisma.$disconnect();
