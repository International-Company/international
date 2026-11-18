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

/** The setting that names the tellers' supervisor, who takes the tellers' drawers at close. */
export const SUPERVISOR_SETTING = 'treasury.supervisorId';

/** The tellers' supervisor, or null when the office has named none. */
export async function supervisorId(db: DbClient = prisma): Promise<string | null> {
  return (await settings.getString(SUPERVISOR_SETTING, db)).trim() || null;
}

/** Held by the tellers' supervisor, named on the settings page; never granted through a role. */
export const SUPERVISE = 'treasury.supervise';

/** The menus the supervisor has hidden from the tellers, by where they lead. */
export const HIDDEN_MENUS_SETTING = 'nav.hiddenForTellers';

/**
 * Marks a menu hidden for this person. Carried among their permissions so that
 * every place the menus are drawn — the sidebar, the search, the shortcuts, the
 * landing page — leaves it out without being told separately.
 */
export const hiddenMark = (href: string) => `nav.hidden:${href}`;

export async function hiddenMenus(db: DbClient = prisma): Promise<string[]> {
  const raw = await settings.get<unknown>(HIDDEN_MENUS_SETTING, db);
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw || '[]');
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Whether this user is the one the settings name. */
export async function isBankExecutor(userId: string, db: DbClient = prisma): Promise<boolean> {
  const named = (await settings.getString(BANK_EXECUTOR_SETTING, db)).trim();
  return Boolean(named) && named === userId;
}
