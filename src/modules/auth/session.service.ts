import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { env } from '@/core/config/env';
import { randomToken, sha256 } from '@/core/security/crypto';
import { createLogger } from '@/core/logger/logger';

/**
 * Server-side sessions backed by an opaque random token.
 *
 * The token is never stored — only its SHA-256 — so a leaked database dump
 * cannot be replayed as a live session. Sessions carry two independent
 * deadlines: a sliding idle timeout and an absolute ceiling that is never
 * extended, so a session cannot be kept alive indefinitely by activity alone.
 */

const log = createLogger('auth:session');

export const SESSION_COOKIE = 'ifms_session';

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  fullNameEn: string;
  fullNameAr: string;
  jobTitleEn: string | null;
  jobTitleAr: string | null;
  status: string;
  locale: string;
  theme: string;
  density: string;
  branchId: string | null;
  branchNameEn: string | null;
  branchNameAr: string | null;
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
  isSystem: boolean;
  roles: { key: string; nameEn: string; nameAr: string; level: number }[];
  permissions: string[];
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  twoFactorSatisfied: boolean;
}

function idleExpiry(from = new Date()): Date {
  return new Date(from.getTime() + env.SESSION_IDLE_MINUTES * 60_000);
}

function absoluteExpiry(from = new Date()): Date {
  return new Date(from.getTime() + env.SESSION_ABSOLUTE_HOURS * 3_600_000);
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export async function createSession(
  userId: string,
  context: { ip?: string | null; userAgent?: string | null; twoFactorSatisfied?: boolean },
  db: DbClient = prisma,
): Promise<CreatedSession> {
  const token = randomToken(32);
  const now = new Date();

  const session = await db.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      ip: context.ip ?? null,
      userAgent: context.userAgent?.slice(0, 500) ?? null,
      expiresAt: idleExpiry(now),
      absoluteExpiresAt: absoluteExpiry(now),
      twoFactorAt: context.twoFactorSatisfied ? now : null,
    },
  });

  return {
    token,
    sessionId: session.id,
    expiresAt: session.expiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
  };
}

/**
 * Resolves a raw token to a live session, or null.
 *
 * Also computes the user's effective permissions: the union of their roles'
 * permissions, plus direct grants, minus direct denials. DENY always wins, and
 * an expired override is ignored.
 */
export async function resolveSession(
  token: string | undefined | null,
  db: DbClient = prisma,
): Promise<ResolvedSession | null> {
  if (!token) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      user: {
        include: {
          branch: { select: { nameEn: true, nameAr: true } },
          roles: {
            include: {
              role: {
                include: { permissions: { include: { permission: { select: { key: true } } } } },
              },
            },
          },
          permissions: { include: { permission: { select: { key: true } } } },
        },
      },
    },
  });

  if (!session) return null;

  const now = new Date();
  if (session.revokedAt) return null;
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) return null;
  if (session.user.status !== 'ACTIVE') return null;

  const granted = new Set<string>();
  const denied = new Set<string>();

  for (const userRole of session.user.roles) {
    if (!userRole.role.isActive) continue;
    for (const rolePermission of userRole.role.permissions) {
      granted.add(rolePermission.permission.key);
    }
  }

  for (const override of session.user.permissions) {
    if (override.expiresAt && override.expiresAt <= now) continue;
    if (override.effect === 'DENY') denied.add(override.permission.key);
    else granted.add(override.permission.key);
  }

  const permissions = [...granted].filter((key) => !denied.has(key)).sort();

  const roles = session.user.roles
    .filter((r) => r.role.isActive)
    .map((r) => ({
      key: r.role.key,
      nameEn: r.role.nameEn,
      nameAr: r.role.nameAr,
      level: r.role.level,
    }));

  return {
    sessionId: session.id,
    expiresAt: session.expiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
    twoFactorSatisfied: session.twoFactorAt !== null,
    user: {
      id: session.user.id,
      username: session.user.username,
      email: session.user.email,
      fullNameEn: session.user.fullNameEn,
      fullNameAr: session.user.fullNameAr,
      jobTitleEn: session.user.jobTitleEn,
      jobTitleAr: session.user.jobTitleAr,
      status: session.user.status,
      locale: session.user.locale,
      theme: session.user.theme,
      density: session.user.density,
      branchId: session.user.branchId,
      branchNameEn: session.user.branch?.nameEn ?? null,
      branchNameAr: session.user.branch?.nameAr ?? null,
      mustChangePassword: session.user.mustChangePassword,
      twoFactorEnabled: session.user.twoFactorEnabled,
      isSystem: session.user.isSystem,
      roles,
      permissions,
    },
  };
}

/**
 * Slides the idle deadline, never past the absolute ceiling.
 * Throttled to once a minute — every request would otherwise write a row.
 */
export async function touchSession(sessionId: string, db: DbClient = prisma): Promise<void> {
  const now = new Date();
  const next = idleExpiry(now);

  try {
    await db.session.updateMany({
      where: {
        id: sessionId,
        revokedAt: null,
        lastSeenAt: { lt: new Date(now.getTime() - 60_000) },
      },
      data: {
        lastSeenAt: now,
        expiresAt: next,
      },
    });

    // Never let the sliding window outlive the hard ceiling.
    await db.$executeRaw`
      UPDATE sessions SET expiresAt = absoluteExpiresAt
      WHERE id = ${sessionId} AND expiresAt > absoluteExpiresAt
    `;
  } catch (error) {
    log.warn('Failed to touch session', { sessionId, error });
  }
}

export async function markTwoFactorSatisfied(sessionId: string, db: DbClient = prisma): Promise<void> {
  await db.session.update({ where: { id: sessionId }, data: { twoFactorAt: new Date() } });
}

export async function revokeSession(
  sessionId: string,
  reason: string,
  db: DbClient = prisma,
): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export async function revokeSessionByToken(
  token: string,
  reason: string,
  db: DbClient = prisma,
): Promise<void> {
  await db.session.updateMany({
    where: { tokenHash: sha256(token), revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** Used on password change, role change and forced sign-out. */
export async function revokeAllUserSessions(
  userId: string,
  reason: string,
  options: { exceptSessionId?: string } = {},
  db: DbClient = prisma,
): Promise<number> {
  const result = await db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

export async function listUserSessions(userId: string, db: DbClient = prisma) {
  const now = new Date();
  return db.session.findMany({
    where: { userId },
    orderBy: { lastSeenAt: 'desc' },
    take: 50,
    select: {
      id: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
      absoluteExpiresAt: true,
      revokedAt: true,
      revokedReason: true,
    },
  }).then((rows) =>
    rows.map((row) => ({
      ...row,
      isActive: !row.revokedAt && row.expiresAt > now && row.absoluteExpiresAt > now,
    })),
  );
}

/** Housekeeping — removes sessions that expired long ago. */
export async function purgeExpiredSessions(olderThanDays = 7, db: DbClient = prisma): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await db.session.deleteMany({
    where: { OR: [{ absoluteExpiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return result.count;
}
