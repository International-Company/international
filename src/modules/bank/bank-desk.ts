import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import * as settings from '@/modules/settings/settings.service';

/**
 * Who works the bank desk.
 *
 * Apart from the desk itself so that resolving a session — which asks this on
 * every request — loads the settings and nothing of the transactions behind it.
 */

/** Held by whoever the settings name as the bank desk; never granted through a role. */
export const BANK_EXECUTE = 'bank.execute';

/** The setting that names them. */
export const BANK_EXECUTOR_SETTING = 'bank.executorId';

/** Whether this user is the one the settings name. */
export async function isBankExecutor(userId: string, db: DbClient = prisma): Promise<boolean> {
  const named = (await settings.getString(BANK_EXECUTOR_SETTING, db)).trim();
  return Boolean(named) && named === userId;
}
