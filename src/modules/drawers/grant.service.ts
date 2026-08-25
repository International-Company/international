/**
 * Who may touch which drawer.
 *
 * ## Why this exists
 *
 * The drawers were all-or-nothing: one permission, `exchange.drawer.manage`,
 * opened every drawer in every currency. That is right for the manager and
 * useless for delegation — "you may move money between these two and nothing
 * else" could not be said at all, so it was not said, and the only way to let
 * somebody help was to hand him the whole treasury.
 *
 * ## Why the grant is the visibility
 *
 * There is no separate "may see" flag. A person sees exactly the drawers he has
 * a row for. This keeps the two things that must agree — what appears on his
 * screen and what the server will accept from him — reading from one place, so
 * a drawer he was never meant to know about cannot appear in a list because one
 * query forgot a filter.
 *
 * ## Why grants only ever add
 *
 * `exchange.drawer.manage` stays unrestricted. A manager who could be locked out
 * of his own treasury by a row in a table is a support call with nobody above
 * him to answer it — and this module is imported by the code that would have to
 * let him back in.
 *
 * ## Why it does not import the drawer service
 *
 * Because the drawer service imports this. The check has to happen inside
 * `fund()`, next to the money, rather than at a route that one caller might
 * forget — so the dependency runs one way and this file talks to the database
 * directly.
 */

import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import * as audit from '@/modules/audit/audit.service';
import type { Actor } from './drawer.service';

const log = createLogger('drawer-grants');

/** What a person can be permitted to do with one drawer. */
export const DRAWER_RIGHTS = ['DEPOSIT', 'WITHDRAW', 'TRANSFER'] as const;
export type DrawerRight = (typeof DRAWER_RIGHTS)[number];

/** The column each right is stored in. */
const COLUMN: Record<DrawerRight, 'canDeposit' | 'canWithdraw' | 'canTransfer'> = {
  DEPOSIT: 'canDeposit',
  WITHDRAW: 'canWithdraw',
  TRANSFER: 'canTransfer',
};

export interface GrantFlags {
  canDeposit: boolean;
  canWithdraw: boolean;
  canTransfer: boolean;
}

/**
 * True when this person is not bound by grants at all.
 *
 * One place, so the answer cannot drift between the screen that lists drawers
 * and the service that moves money out of them.
 */
export function unrestricted(actor: Actor): boolean {
  return actor.permissions?.includes('exchange.drawer.manage') ?? false;
}

/**
 * The drawers this person may see, or `null` for "all of them".
 *
 * Null rather than a set of every id on purpose: the caller that filters a list
 * should be able to skip the work entirely for a manager, and a set that
 * happened to contain everything would look the same as one that happened to
 * contain everything *today*.
 */
export async function visibleDrawerIds(
  actor: Actor,
  db: DbClient = prisma,
): Promise<Set<string> | null> {
  if (unrestricted(actor)) return null;

  const rows = await db.drawerGrant.findMany({
    where: { userId: actor.id },
    select: { drawerId: true },
  });

  return new Set(rows.map((row) => row.drawerId));
}

/** What this person may do with one drawer. Everything, for a manager. */
export async function rightsOn(
  actor: Actor,
  drawerId: string,
  db: DbClient = prisma,
): Promise<GrantFlags> {
  if (unrestricted(actor)) {
    return { canDeposit: true, canWithdraw: true, canTransfer: true };
  }

  const grant = await db.drawerGrant.findUnique({
    where: { userId_drawerId: { userId: actor.id, drawerId } },
    select: { canDeposit: true, canWithdraw: true, canTransfer: true },
  });

  return grant ?? { canDeposit: false, canWithdraw: false, canTransfer: false };
}

/**
 * Refuses unless this person holds this right on this drawer.
 *
 * The message says which drawer and which right rather than a bare "forbidden",
 * because the person hitting this is usually somebody who was granted *almost*
 * enough, and telling him which half is missing is the difference between a
 * question for the manager and a shrug.
 */
export async function assertRight(
  actor: Actor,
  drawer: { id: string; nameAr?: string; nameEn?: string },
  right: DrawerRight,
  db: DbClient = prisma,
): Promise<void> {
  if (unrestricted(actor)) return;

  const rights = await rightsOn(actor, drawer.id, db);
  if (rights[COLUMN[right]]) return;

  log.warn('Drawer right refused', { actor: actor.id, drawer: drawer.id, right });

  throw errors.forbidden(`exchange.drawer.${right.toLowerCase()}`, {
    message: `You are not permitted to ${right.toLowerCase()} in this drawer`,
    messageKey: `errors.drawerRight.${right}`,
    params: { drawer: drawer.nameAr ?? drawer.nameEn ?? drawer.id },
  });
}

// ---------------------------------------------------------------------------
// Managing them
// ---------------------------------------------------------------------------

/** Every grant a person holds, with the drawer each one is on. */
export async function grantsFor(userId: string, db: DbClient = prisma) {
  return db.drawerGrant.findMany({
    where: { userId },
    orderBy: [{ drawer: { ownerKey: 'asc' } }, { drawer: { sortOrder: 'asc' } }],
    include: {
      drawer: {
        select: {
          id: true,
          nameAr: true,
          nameEn: true,
          kind: true,
          currencyCode: true,
          ownerKey: true,
        },
      },
    },
  });
}

/** Everyone who holds at least one grant, and how many. */
export async function delegates(db: DbClient = prisma) {
  const rows = await db.drawerGrant.groupBy({
    by: ['userId'],
    _count: { _all: true },
  });

  if (rows.length === 0) return [];

  const users = await db.user.findMany({
    where: { id: { in: rows.map((row) => row.userId) } },
    select: { id: true, fullNameAr: true, fullNameEn: true, username: true },
  });

  const counts = new Map(rows.map((row) => [row.userId, row._count._all]));

  return users.map((user) => ({ ...user, drawers: counts.get(user.id) ?? 0 }));
}

/** The permission that puts the transfers screen in somebody's sidebar. */
const TRANSFER_PERMISSION = 'exchange.transfer.use';

/**
 * Gives a delegate the page his grant is about, if he has no way to it.
 *
 * Skipped silently when he already holds it — through his role or a previous
 * grant — so ticking a second drawer does not write a second identical
 * override, and a manager who deliberately DENIED it keeps his refusal.
 */
async function ensureCanReachTransfers(userId: string, actor: Actor, db: DbClient) {
  const permission = await db.permission.findUnique({
    where: { key: TRANSFER_PERMISSION },
    select: { id: true },
  });
  // Missing only on a database whose catalogue has not been synced yet. Nothing
  // useful to do about it here, and refusing the grant would be worse.
  if (!permission) return;

  const [existing, viaRole] = await Promise.all([
    db.userPermission.findFirst({
      where: { userId, permissionId: permission.id },
      select: { effect: true },
    }),
    db.userRole.findFirst({
      where: { userId, role: { permissions: { some: { permissionId: permission.id } } } },
      select: { roleId: true },
    }),
  ]);

  if (existing || viaRole) return;

  await db.userPermission.create({
    data: { userId, permissionId: permission.id, effect: 'ALLOW', assignedBy: actor.id },
  });

  await audit.record({
    action: 'PERMISSION_CHANGE',
    module: 'exchange',
    entityType: 'User',
    entityId: userId,
    summaryEn: `Granted ${TRANSFER_PERMISSION} so the drawer delegation can be used`,
    summaryAr: 'مُنح الوصول إلى شاشة التحويلات ليتمكن من استعمال التفويض',
    actor,
    after: { permission: TRANSFER_PERMISSION, effect: 'ALLOW' },
  });

  log.info('Transfer permission granted with delegation', { user: userId });
}

/**
 * Everyone who could be delegated to.
 *
 * The manager himself is left out — he already holds every drawer, and a row
 * offering to grant him one of them would read as though it meant something.
 * So is anyone else who holds `exchange.drawer.manage`, for the same reason.
 */
export async function candidates(actor: Actor, db: DbClient = prisma) {
  const MANAGE = 'exchange.drawer.manage';

  return db.user.findMany({
    where: {
      status: 'ACTIVE',
      id: { not: actor.id },
      // Held through a role, or granted to the person directly — both make a
      // grant meaningless, and both have to be excluded or the list offers to
      // give somebody something he already has.
      NOT: {
        OR: [
          { roles: { some: { role: { permissions: { some: { permission: { key: MANAGE } } } } } } },
          { permissions: { some: { effect: 'ALLOW', permission: { key: MANAGE } } } },
        ],
      },
    },
    orderBy: { fullNameEn: 'asc' },
    select: {
      id: true,
      username: true,
      fullNameAr: true,
      fullNameEn: true,
      jobTitleAr: true,
      jobTitleEn: true,
    },
  });
}

/**
 * Sets what one person may do with one drawer.
 *
 * A grant with nothing ticked is deleted rather than stored, because an empty
 * row still means something here — it is what makes the drawer visible — and a
 * manager who unticks the last box means "he should not see this at all", not
 * "he should see it and be able to do nothing".
 */
export async function setGrant(
  input: { userId: string; drawerId: string } & Partial<GrantFlags>,
  actor: Actor,
  db: DbClient = prisma,
): Promise<GrantFlags | null> {
  if (!unrestricted(actor)) throw errors.forbidden('exchange.drawer.manage');

  const [user, drawer] = await Promise.all([
    db.user.findUnique({
      where: { id: input.userId },
      select: { id: true, fullNameAr: true, fullNameEn: true },
    }),
    db.drawer.findUnique({
      where: { id: input.drawerId },
      select: { id: true, nameAr: true, nameEn: true, ownerKey: true },
    }),
  ]);

  if (!user) throw errors.notFound('User', input.userId);
  if (!drawer) throw errors.notFound('Drawer', input.drawerId);

  /*
   * A person cannot be granted rights over a drawer that is already his own.
   *
   * His own drawer is his by holding it, not by a row here, and a grant on it
   * would be a second answer to the same question — one that could be revoked
   * while the money stayed in his hands.
   */
  if (drawer.ownerKey === `teller:${user.id}`) {
    throw errors.precondition(
      'That drawer already belongs to this person',
      'errors.grantOwnDrawer',
    );
  }

  const flags: GrantFlags = {
    canDeposit: input.canDeposit ?? false,
    canWithdraw: input.canWithdraw ?? false,
    canTransfer: input.canTransfer ?? false,
  };

  const name = drawer.nameAr || drawer.nameEn;
  const person = user.fullNameAr || user.fullNameEn;
  const none = !flags.canDeposit && !flags.canWithdraw && !flags.canTransfer;

  if (none) {
    const existing = await db.drawerGrant.findUnique({
      where: { userId_drawerId: { userId: user.id, drawerId: drawer.id } },
      select: { id: true },
    });
    if (!existing) return null;

    await db.drawerGrant.delete({ where: { id: existing.id } });

    await audit.record({
      action: 'PERMISSION_CHANGE',
      module: 'exchange',
      entityType: 'DrawerGrant',
      entityId: `${user.id}:${drawer.id}`,
      summaryEn: `Removed ${person}'s access to ${drawer.nameEn}`,
      summaryAr: `أُلغي وصول ${person} إلى ${name}`,
      actor,
      before: { userId: user.id, drawerId: drawer.id },
    });

    log.info('Drawer grant removed', { user: user.id, drawer: drawer.id });
    return null;
  }

  await db.drawerGrant.upsert({
    where: { userId_drawerId: { userId: user.id, drawerId: drawer.id } },
    create: { userId: user.id, drawerId: drawer.id, grantedById: actor.id, ...flags },
    update: { grantedById: actor.id, ...flags },
  });

  /*
   * The screen comes with the right.
   *
   * A grant to move money between drawers is inert without the page that does
   * it, and the page is reached through a permission the teller's role
   * deliberately withholds. Leaving those two as separate errands means the
   * manager ticks a box, the employee sees nothing, and neither of them can
   * tell which half is missing. So the second half is done here — recorded as
   * its own permission change, not hidden.
   */
  if (flags.canTransfer) await ensureCanReachTransfers(user.id, actor, db);

  // Spelled out in the summary rather than left as three booleans: this is the
  // line a manager reads months later when he is asking how somebody came to be
  // able to do what he just did.
  const allowedEn = [
    flags.canDeposit ? 'deposit' : null,
    flags.canWithdraw ? 'withdraw' : null,
    flags.canTransfer ? 'transfer' : null,
  ].filter(Boolean);
  const allowedAr = [
    flags.canDeposit ? 'الإيداع' : null,
    flags.canWithdraw ? 'السحب' : null,
    flags.canTransfer ? 'التحويل' : null,
  ].filter(Boolean);

  await audit.record({
    action: 'PERMISSION_CHANGE',
    module: 'exchange',
    entityType: 'DrawerGrant',
    entityId: `${user.id}:${drawer.id}`,
    summaryEn: `${person} may now ${allowedEn.join(', ')} in ${drawer.nameEn}`,
    summaryAr: `${person} يستطيع الآن ${allowedAr.join('، ')} في ${name}`,
    actor,
    after: { userId: user.id, drawerId: drawer.id, ...flags },
  });

  log.info('Drawer grant set', { user: user.id, drawer: drawer.id, ...flags });
  return flags;
}

/** Takes away everything one person holds, in one act. */
export async function revokeAll(
  userId: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<number> {
  if (!unrestricted(actor)) throw errors.forbidden('exchange.drawer.manage');

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, fullNameAr: true, fullNameEn: true },
  });
  if (!user) throw errors.notFound('User', userId);

  const { count } = await db.drawerGrant.deleteMany({ where: { userId } });
  if (count === 0) return 0;

  const person = user.fullNameAr || user.fullNameEn;

  await audit.record({
    action: 'PERMISSION_CHANGE',
    module: 'exchange',
    entityType: 'DrawerGrant',
    entityId: user.id,
    summaryEn: `Removed ${person}'s access to all ${count} drawer(s)`,
    summaryAr: `أُلغي وصول ${person} إلى الصناديق كلها (${count})`,
    actor,
    before: { userId: user.id, drawers: count },
  });

  log.info('Drawer grants revoked', { user: user.id, count });
  return count;
}
