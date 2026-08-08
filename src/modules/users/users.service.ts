import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { generatePassword } from '@/core/security/password';
import { PERMISSIONS_BY_KEY } from '@/core/security/permissions';
import * as audit from '@/modules/audit/audit.service';
import { applyNewPassword } from '@/modules/auth/auth.service';
import { revokeAllUserSessions } from '@/modules/auth/session.service';
import { containsInsensitive } from '@/core/db/search';

/**
 * User administration.
 *
 * Two rules run through everything here:
 *
 *  1. Authority is hierarchical. A user may only manage accounts whose most
 *     senior role is *less* senior than their own, so a manager cannot edit an
 *     administrator or quietly promote themselves.
 *  2. Any change to credentials or rights invalidates existing sessions, so a
 *     revoked permission takes effect immediately rather than whenever the
 *     affected user happens to sign out.
 */

const log = createLogger('users');

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
}

/** The most senior (numerically lowest) role level a user holds. */
async function authorityLevel(userId: string, db: DbClient): Promise<number> {
  const roles = await db.userRole.findMany({
    where: { userId },
    include: { role: { select: { level: true } } },
  });
  if (roles.length === 0) return Number.MAX_SAFE_INTEGER;
  return Math.min(...roles.map((r) => r.role.level));
}

/**
 * Throws unless `actor` outranks `targetUserId`. Equal rank is not enough —
 * two managers must not be able to lock each other out.
 */
async function assertOutranks(actor: Actor, targetUserId: string, db: DbClient): Promise<void> {
  if (actor.id === targetUserId) return;

  const [actorLevel, targetLevel] = await Promise.all([
    authorityLevel(actor.id, db),
    authorityLevel(targetUserId, db),
  ]);

  if (actorLevel >= targetLevel) {
    throw errors.forbidden('You cannot manage a user at or above your own authority level');
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface UserFilter {
  search?: string;
  status?: string;
  roleKey?: string;
  branchId?: string;
  page?: number;
  pageSize?: number;
}

export async function listUsers(filter: UserFilter, db: DbClient = prisma) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filter.pageSize ?? 25));

  const where = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.branchId ? { branchId: filter.branchId } : {}),
    ...(filter.roleKey ? { roles: { some: { role: { key: filter.roleKey } } } } : {}),
    ...(filter.search
      ? {
          OR: [
            { username: containsInsensitive(filter.search) },
            { email: containsInsensitive(filter.search) },
            { fullNameEn: containsInsensitive(filter.search) },
            { fullNameAr: containsInsensitive(filter.search) },
            { employeeCode: containsInsensitive(filter.search) },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        username: true,
        email: true,
        employeeCode: true,
        fullNameEn: true,
        fullNameAr: true,
        jobTitleEn: true,
        jobTitleAr: true,
        status: true,
        lastLoginAt: true,
        twoFactorEnabled: true,
        mustChangePassword: true,
        lockedUntil: true,
        createdAt: true,
        isSystem: true,
        branch: { select: { id: true, nameEn: true, nameAr: true } },
        roles: { include: { role: { select: { key: true, nameEn: true, nameAr: true, level: true } } } },
      },
    }),
    db.user.count({ where }),
  ]);

  return { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function getUser(id: string, db: DbClient = prisma) {
  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      email: true,
      employeeCode: true,
      fullNameEn: true,
      fullNameAr: true,
      jobTitleEn: true,
      jobTitleAr: true,
      phone: true,
      status: true,
      locale: true,
      theme: true,
      twoFactorEnabled: true,
      mustChangePassword: true,
      passwordUpdatedAt: true,
      failedLoginCount: true,
      lockedUntil: true,
      lastLoginAt: true,
      lastLoginIp: true,
      createdAt: true,
      isSystem: true,
      branch: { select: { id: true, nameEn: true, nameAr: true } },
      roles: { include: { role: true } },
      permissions: { include: { permission: true } },
    },
  });

  if (!user) throw errors.notFound('User', id);
  return user;
}

// ---------------------------------------------------------------------------
// Creation & updates
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  username: string;
  email: string;
  fullNameEn: string;
  fullNameAr: string;
  employeeCode?: string | null;
  jobTitleEn?: string | null;
  jobTitleAr?: string | null;
  phone?: string | null;
  branchId?: string | null;
  roleIds: string[];
  locale?: string;
}

export async function createUser(
  input: CreateUserInput,
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ id: string; temporaryPassword: string }> {
  if (input.roleIds.length === 0) {
    throw errors.validation([{ path: 'roleIds', message: 'Assign at least one role' }]);
  }

  return withTransaction(async (tx) => {
    const roles = await tx.role.findMany({ where: { id: { in: input.roleIds } } });
    if (roles.length !== input.roleIds.length) {
      throw errors.notFound('Role');
    }

    // Nobody may create an account more powerful than their own.
    const actorLevel = await authorityLevel(actor.id, tx);
    const highest = Math.min(...roles.map((role) => role.level));
    if (highest < actorLevel) {
      throw errors.forbidden('You cannot grant a role more senior than your own');
    }

    const temporaryPassword = generatePassword(14);

    const user = await tx.user.create({
      data: {
        username: input.username.trim().toLowerCase(),
        email: input.email.trim().toLowerCase(),
        fullNameEn: input.fullNameEn.trim(),
        fullNameAr: input.fullNameAr.trim(),
        employeeCode: input.employeeCode || null,
        jobTitleEn: input.jobTitleEn || null,
        jobTitleAr: input.jobTitleAr || null,
        phone: input.phone || null,
        branchId: input.branchId || null,
        locale: input.locale ?? 'ar',
        // Placeholder — replaced below once the record exists.
        passwordHash: 'pending',
        mustChangePassword: true,
        roles: { createMany: { data: input.roleIds.map((roleId) => ({ roleId, assignedBy: actor.id })) } },
      },
    });

    await audit.record(
      {
        action: 'CREATE',
        module: 'users',
        entityType: 'User',
        entityId: user.id,
        summaryEn: `Created user "${user.username}" (${input.fullNameEn}) with roles ${roles.map((r) => r.key).join(', ')}`,
        summaryAr: `إنشاء المستخدم "${user.username}" (${input.fullNameAr}) بالأدوار ${roles.map((r) => r.key).join('، ')}`,
        actor,
        after: { username: user.username, email: user.email, roles: roles.map((r) => r.key) },
      },
      tx,
    );

    return { id: user.id, temporaryPassword };
  }, db).then(async (result) => {
    // Password hashing is deliberately slow; doing it outside the transaction
    // keeps a write lock from being held for ~80ms per user created.
    await applyNewPassword(
      result.id,
      result.temporaryPassword,
      { username: input.username, email: input.email, fullName: input.fullNameEn },
      { mustChangePassword: true },
    );
    return result;
  });
}

export interface UpdateUserInput {
  email?: string;
  fullNameEn?: string;
  fullNameAr?: string;
  employeeCode?: string | null;
  jobTitleEn?: string | null;
  jobTitleAr?: string | null;
  phone?: string | null;
  branchId?: string | null;
  status?: 'ACTIVE' | 'SUSPENDED' | 'DISABLED';
}

export async function updateUser(
  id: string,
  input: UpdateUserInput,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { id } });
    if (!existing) throw errors.notFound('User', id);
    if (existing.isSystem) {
      throw errors.precondition('The system account cannot be modified', 'errors.systemAccount');
    }

    await assertOutranks(actor, id, tx);

    const updated = await tx.user.update({
      where: { id },
      data: {
        ...(input.email !== undefined ? { email: input.email.trim().toLowerCase() } : {}),
        ...(input.fullNameEn !== undefined ? { fullNameEn: input.fullNameEn.trim() } : {}),
        ...(input.fullNameAr !== undefined ? { fullNameAr: input.fullNameAr.trim() } : {}),
        ...(input.employeeCode !== undefined ? { employeeCode: input.employeeCode || null } : {}),
        ...(input.jobTitleEn !== undefined ? { jobTitleEn: input.jobTitleEn || null } : {}),
        ...(input.jobTitleAr !== undefined ? { jobTitleAr: input.jobTitleAr || null } : {}),
        ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
        ...(input.branchId !== undefined ? { branchId: input.branchId || null } : {}),
        ...(input.status !== undefined
          ? { status: input.status, ...(input.status === 'ACTIVE' ? { lockedUntil: null, failedLoginCount: 0 } : {}) }
          : {}),
      },
    });

    const changes = audit.diff(
      existing as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
      { ignore: ['updatedAt', 'passwordHash', 'twoFactorSecret', 'recoveryCodes'] },
    );

    await audit.record(
      {
        action: 'UPDATE',
        module: 'users',
        entityType: 'User',
        entityId: id,
        summaryEn: `Updated user "${existing.username}" (${changes.changed.join(', ') || 'no changes'})`,
        summaryAr: `تعديل المستخدم "${existing.username}" (${changes.changed.join('، ') || 'بدون تغييرات'})`,
        actor,
        before: changes.before,
        after: changes.after,
      },
      tx,
    );

    // Suspending an account must take effect now, not at next sign-in.
    if (input.status && input.status !== 'ACTIVE') {
      await revokeAllUserSessions(id, `STATUS_${input.status}`, {}, tx);
    }
  }, db);
}

export async function resetPassword(
  id: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<{ temporaryPassword: string }> {
  const user = await db.user.findUnique({ where: { id } });
  if (!user) throw errors.notFound('User', id);
  if (user.isSystem) {
    throw errors.precondition('The system account has no password', 'errors.systemAccount');
  }

  await assertOutranks(actor, id, db);

  const temporaryPassword = generatePassword(14);

  await applyNewPassword(
    id,
    temporaryPassword,
    { username: user.username, email: user.email, fullName: user.fullNameEn },
    { mustChangePassword: true },
  );

  const revoked = await revokeAllUserSessions(id, 'PASSWORD_RESET', {}, db);

  await audit.record(
    {
      action: 'PASSWORD_RESET',
      module: 'users',
      entityType: 'User',
      entityId: id,
      summaryEn: `Reset password for "${user.username}" and revoked ${revoked} session(s)`,
      summaryAr: `إعادة تعيين كلمة مرور "${user.username}" وإنهاء ${revoked} جلسة`,
      actor,
    },
    db,
  );

  return { temporaryPassword };
}

/**
 * Removes an account entirely.
 *
 * Only an account that never did anything. The moment someone has recorded a
 * transaction, moved a drawer or opened a day, their name is the answer to "who
 * did this" — and deleting them would either break those records or, worse,
 * leave them pointing at nobody. Disabling is offered instead, which stops the
 * sign-in and keeps the history readable.
 *
 * This is why the screen shows both: they are different acts, not a soft and a
 * hard version of one.
 */
export async function deleteUser(id: string, actor: Actor, db: DbClient = prisma): Promise<void> {
  await withTransaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { id } });
    if (!existing) throw errors.notFound('User', id);

    if (existing.isSystem) {
      throw errors.precondition('The system account cannot be deleted', 'errors.systemAccount');
    }
    if (existing.id === actor.id) {
      throw errors.precondition('You cannot delete your own account', 'errors.cannotDeleteSelf');
    }

    await assertOutranks(actor, id, tx);

    const [transactions, movements, daysOpened, daysClosed, requests] = await Promise.all([
      tx.transaction.count({ where: { createdById: id } }),
      tx.drawerMovement.count({ where: { createdById: id } }),
      tx.businessDay.count({ where: { openedById: id } }),
      tx.businessDay.count({ where: { closedById: id } }),
      tx.usdtDepositRequest.count({ where: { createdById: id } }),
    ]);

    const work = transactions + movements + daysOpened + daysClosed + requests;
    if (work > 0) {
      throw errors.conflict(
        `"${existing.username}" has ${work} record(s) against their name and cannot be deleted — disable the account instead`,
        'errors.userHasWork',
        { username: existing.username, count: work },
      );
    }

    // The last account that can still administer the system must not be the one
    // being removed, or nobody can let anybody back in.
    const managers = await tx.user.count({
      where: {
        id: { not: id },
        isSystem: false,
        status: 'ACTIVE',
        roles: { some: { role: { key: 'ADMIN' } } },
      },
    });
    const isManager = await tx.userRole.findFirst({
      where: { userId: id, role: { key: 'ADMIN' } },
    });
    if (isManager && managers === 0) {
      throw errors.precondition(
        'This is the only manager left — promote someone else first',
        'errors.lastManager',
      );
    }

    await audit.record(
      {
        action: 'DELETE',
        module: 'users',
        entityType: 'User',
        entityId: id,
        summaryEn: `Deleted user "${existing.username}" (${existing.fullNameEn})`,
        summaryAr: `حذف المستخدم "${existing.username}" (${existing.fullNameAr})`,
        actor,
        before: { username: existing.username, email: existing.email, status: existing.status },
      },
      tx,
    );

    // Recorded before the row goes, so the audit line survives the cascade that
    // takes the sessions, roles and overrides with it.
    await tx.user.delete({ where: { id } });
  }, db);

  log.warn('User deleted', { id, by: actor.id });
}

// ---------------------------------------------------------------------------
// Roles & permission overrides
// ---------------------------------------------------------------------------

export async function setUserRoles(
  id: string,
  roleIds: string[],
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw errors.notFound('User', id);
    if (user.isSystem) {
      throw errors.precondition('The system account cannot be modified', 'errors.systemAccount');
    }

    await assertOutranks(actor, id, tx);

    const roles = await tx.role.findMany({ where: { id: { in: roleIds } } });
    if (roles.length !== roleIds.length) throw errors.notFound('Role');

    const actorLevel = await authorityLevel(actor.id, tx);
    if (roles.some((role) => role.level < actorLevel)) {
      throw errors.forbidden('You cannot grant a role more senior than your own');
    }

    await tx.userRole.deleteMany({ where: { userId: id } });
    await tx.userRole.createMany({
      data: roleIds.map((roleId) => ({ userId: id, roleId, assignedBy: actor.id })),
    });

    const before = user.roles.map((r) => r.role.key).sort();
    const after = roles.map((r) => r.key).sort();

    await audit.record(
      {
        action: 'ROLE_CHANGE',
        module: 'users',
        entityType: 'User',
        entityId: id,
        summaryEn: `Roles for "${user.username}" changed from [${before.join(', ')}] to [${after.join(', ')}]`,
        summaryAr: `تغيير أدوار "${user.username}" من [${before.join('، ')}] إلى [${after.join('، ')}]`,
        actor,
        before: { roles: before },
        after: { roles: after },
      },
      tx,
    );

    // Session snapshots carry resolved permissions, so they must be rebuilt.
    await revokeAllUserSessions(id, 'ROLES_CHANGED', {}, tx);
  }, db);
}

export async function setUserPermissionOverrides(
  id: string,
  overrides: { permissionKey: string; effect: 'ALLOW' | 'DENY'; reason?: string }[],
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) throw errors.notFound('User', id);

    await assertOutranks(actor, id, tx);

    const keys = overrides.map((override) => override.permissionKey);
    const unknown = keys.find((key) => !PERMISSIONS_BY_KEY.has(key));
    if (unknown) throw errors.notFound('Permission', unknown);

    const permissions = await tx.permission.findMany({ where: { key: { in: keys } } });
    const idByKey = new Map(permissions.map((permission) => [permission.key, permission.id]));

    await tx.userPermission.deleteMany({ where: { userId: id } });

    if (overrides.length > 0) {
      await tx.userPermission.createMany({
        data: overrides.map((override) => ({
          userId: id,
          permissionId: idByKey.get(override.permissionKey)!,
          effect: override.effect,
          reason: override.reason ?? null,
          assignedBy: actor.id,
        })),
      });
    }

    await audit.record(
      {
        action: 'PERMISSION_CHANGE',
        module: 'users',
        entityType: 'User',
        entityId: id,
        summaryEn: `Permission overrides for "${user.username}" set to ${overrides.length} entr(ies)`,
        summaryAr: `ضبط استثناءات صلاحيات "${user.username}" إلى ${overrides.length} بند`,
        actor,
        after: { overrides },
      },
      tx,
    );

    await revokeAllUserSessions(id, 'PERMISSIONS_CHANGED', {}, tx);
  }, db);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export async function listRoles(db: DbClient = prisma) {
  return db.role.findMany({
    orderBy: { level: 'asc' },
    include: {
      permissions: { include: { permission: { select: { key: true } } } },
      _count: { select: { users: true } },
    },
  });
}

export async function setRolePermissions(
  roleId: string,
  permissionKeys: string[],
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx) => {
    const role = await tx.role.findUnique({
      where: { id: roleId },
      include: { permissions: { include: { permission: { select: { key: true } } } } },
    });
    if (!role) throw errors.notFound('Role', roleId);

    const actorLevel = await authorityLevel(actor.id, tx);
    if (role.level < actorLevel) {
      throw errors.forbidden('You cannot modify a role more senior than your own');
    }

    // Granting a permission you do not hold would be privilege escalation by
    // proxy: assign the role to yourself afterwards and you have it.
    const grantable = new Set(actor.permissions);
    const overreach = permissionKeys.find((key) => !grantable.has(key));
    if (overreach) {
      throw errors.forbidden(`You cannot grant "${overreach}" because you do not hold it`);
    }

    const permissions = await tx.permission.findMany({ where: { key: { in: permissionKeys } } });

    await tx.rolePermission.deleteMany({ where: { roleId } });
    if (permissions.length > 0) {
      await tx.rolePermission.createMany({
        data: permissions.map((permission) => ({ roleId, permissionId: permission.id })),
      });
    }

    const before = role.permissions.map((p) => p.permission.key).sort();
    const after = permissionKeys.slice().sort();

    await audit.record(
      {
        action: 'PERMISSION_CHANGE',
        module: 'users',
        entityType: 'Role',
        entityId: roleId,
        summaryEn: `Permissions for role "${role.key}" changed (${before.length} → ${after.length})`,
        summaryAr: `تغيير صلاحيات الدور "${role.key}" (${before.length} ← ${after.length})`,
        actor,
        before: { permissions: before },
        after: { permissions: after },
      },
      tx,
    );

    // Everyone holding this role needs a fresh permission snapshot.
    const holders = await tx.userRole.findMany({ where: { roleId }, select: { userId: true } });
    for (const holder of holders) {
      await revokeAllUserSessions(holder.userId, 'ROLE_PERMISSIONS_CHANGED', {}, tx);
    }
  }, db);
}
