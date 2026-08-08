#!/usr/bin/env node
/**
 * The other half of the reduction migration.
 *
 * `pre-deploy-schema.mjs` runs before `prisma db push` and can only speak SQL,
 * because the tables it is preparing for do not exist yet. This runs after, when
 * they do — so the money it carried across can be put where it belongs.
 *
 * Idempotent, like its counterpart: it runs on every deploy and must be a no-op
 * once there is nothing left to carry.
 *
 * PostgreSQL only. Local development rebuilds freely.
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

/** Names a drawer the way the seeder would, so the two never disagree. */
const NAMES = {
  ILS: { en: 'Israeli Shekel drawer', ar: 'صندوق شيكل إسرائيلي' },
  USD: { en: 'US Dollar drawer', ar: 'صندوق دولار أمريكي' },
  JOD: { en: 'Jordanian Dinar drawer', ar: 'صندوق دينار أردني' },
  USDT: { en: 'Tether USD drawer', ar: 'صندوق تيثر USD' },
};

async function main() {
  const url = databaseUrl();

  if (!url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    console.log('[post-deploy] Not PostgreSQL — nothing to do.');
    return;
  }

  const prisma = new PrismaClient();

  try {
    const [{ exists }] = await prisma.$queryRawUnsafe(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = '_ifms_drawer_carryover'
       ) AS exists`,
    );

    if (!exists) {
      console.log('[post-deploy] Nothing carried over — nothing to place.');
      return;
    }

    const carried = await prisma.$queryRawUnsafe(
      `SELECT "currencyCode", "balance" FROM "_ifms_drawer_carryover"`,
    );

    for (const row of carried) {
      const code = row.currencyCode;
      const balance = BigInt(row.balance);
      const name = NAMES[code] ?? { en: `${code} drawer`, ar: `صندوق ${code}` };

      // `create` only. A drawer that already exists has been traded through
      // since, and its balance is the truth — overwriting it with a figure from
      // the old chart of accounts would undo real work.
      const existing = await prisma.drawer.findUnique({ where: { currencyCode: code } });
      if (existing) {
        console.log(`[post-deploy] ${code} drawer already exists — left alone.`);
        continue;
      }

      await prisma.drawer.create({
        data: { currencyCode: code, nameEn: name.en, nameAr: name.ar, balance },
      });

      // The balance has to be explainable, so it arrives with the movement that
      // explains it rather than appearing from nowhere.
      if (balance !== 0n) {
        const system = await prisma.user.findFirst({ where: { isSystem: true }, select: { id: true } });
        const drawer = await prisma.drawer.findUniqueOrThrow({ where: { currencyCode: code } });

        if (system) {
          await prisma.drawerMovement.create({
            data: {
              drawerId: drawer.id,
              direction: balance > 0n ? 'IN' : 'OUT',
              amount: balance > 0n ? balance : -balance,
              balanceAfter: balance,
              reason: 'FUNDING',
              note: 'Carried over from the chart of accounts',
              createdById: system.id,
            },
          });
        }
      }

      console.log(`[post-deploy] ${code} drawer created holding ${balance}.`);
    }

    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "_ifms_drawer_carryover";`);
    console.log(`[post-deploy] Placed ${carried.length} drawer balance(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('\n[post-deploy] Failed to place the carried balances:\n', error);
  process.exit(1);
});
