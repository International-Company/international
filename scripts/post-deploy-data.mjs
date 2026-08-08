#!/usr/bin/env node
/**
 * The other half of the reduction migration.
 *
 * `pre-deploy-schema.mjs` creates the drawers and carries the branch's money
 * into them before the chart of accounts is dropped. It can only speak SQL, and
 * `drawer_movements` does not exist until `prisma db push` has run — so the
 * movement that *explains* each carried balance has to be written here.
 *
 * That matters more than it looks. A drawer balance is supposed to be the sum of
 * everything recorded against it, and `verifyBalances()` checks exactly that on
 * a schedule. A balance carried in silently would fail that check on the first
 * night and report a discrepancy nobody caused.
 *
 * Idempotent: it runs on every deploy and is a no-op once every drawer's balance
 * is already accounted for.
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

async function main() {
  const url = databaseUrl();

  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    console.log('[post-deploy] Not PostgreSQL — nothing to do.');
    return;
  }

  const prisma = new PrismaClient();

  try {
    const drawers = await prisma.drawer.findMany();
    if (drawers.length === 0) {
      console.log('[post-deploy] No drawers yet — nothing to account for.');
      return;
    }

    // Whoever owns records the system creates on its own. Without it there is
    // nobody to attribute the movement to, so the balance is left as it is and
    // the next deploy — after the seed has made the account — picks it up.
    const system = await prisma.user.findFirst({ where: { isSystem: true }, select: { id: true } });
    if (!system) {
      console.log('[post-deploy] No system account yet — will account for balances next deploy.');
      return;
    }

    let explained = 0;

    for (const drawer of drawers) {
      if (drawer.balance === 0n) continue;

      const recorded = await prisma.drawerMovement.count({ where: { drawerId: drawer.id } });
      if (recorded > 0) continue;

      await prisma.drawerMovement.create({
        data: {
          drawerId: drawer.id,
          direction: drawer.balance > 0n ? 'IN' : 'OUT',
          amount: drawer.balance > 0n ? drawer.balance : -drawer.balance,
          balanceAfter: drawer.balance,
          reason: 'FUNDING',
          note: 'Carried over from the chart of accounts',
          createdById: system.id,
        },
      });

      explained++;
      console.log(`[post-deploy] ${drawer.currencyCode} drawer holds ${drawer.balance}, now accounted for.`);
    }

    console.log(
      explained > 0
        ? `[post-deploy] Explained ${explained} carried balance(s).`
        : '[post-deploy] Every drawer balance is already accounted for.',
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('\n[post-deploy] Failed to account for the carried balances:\n', error);
  process.exit(1);
});
