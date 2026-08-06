import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { createLogger } from '@/core/logger/logger';
import { containsInsensitive } from '@/core/db/search';

/**
 * Central notification service.
 *
 * A notification is written once and fanned out to recipients, so a message
 * sent to every manager is one row plus N cheap recipient rows rather than N
 * duplicated bodies. Read state is per recipient.
 *
 * Both language variants are stored at write time. Rendering them lazily would
 * mean re-deriving historical context — the amount, the customer name, the rate
 * in force — long after it changed, and a notification that silently rewrites
 * itself is worse than useless in a financial audit.
 */

const log = createLogger('notifications');

export type Severity = 'CRITICAL' | 'WARNING' | 'INFO' | 'SUCCESS';

export interface NotifyInput {
  severity: Severity;
  /** Machine key for grouping and filtering, e.g. `usdt.incoming`. */
  eventKey: string;
  module: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
  entityType?: string;
  entityId?: string;
  link?: string;
  payload?: Record<string, unknown>;
  expiresAt?: Date;
  createdById?: string;
}

export interface Audience {
  /** Explicit user ids. */
  userIds?: string[];
  /** Everyone holding this permission. */
  permission?: string;
  /** Everyone holding one of these role keys. */
  roleKeys?: string[];
  /** Restrict a permission/role audience to one branch. */
  branchId?: string;
  /** Never notify this user — normally the person who caused the event. */
  exceptUserId?: string;
}

/** Resolves an audience to concrete, active user ids. */
async function resolveAudience(audience: Audience, db: DbClient): Promise<string[]> {
  const ids = new Set<string>(audience.userIds ?? []);

  if (audience.permission || audience.roleKeys?.length) {
    const users = await db.user.findMany({
      where: {
        status: 'ACTIVE',
        ...(audience.branchId ? { branchId: audience.branchId } : {}),
        OR: [
          ...(audience.permission
            ? [
                {
                  roles: {
                    some: {
                      role: {
                        isActive: true,
                        permissions: { some: { permission: { key: audience.permission } } },
                      },
                    },
                  },
                },
                {
                  permissions: {
                    some: { effect: 'ALLOW', permission: { key: audience.permission } },
                  },
                },
              ]
            : []),
          ...(audience.roleKeys?.length
            ? [{ roles: { some: { role: { key: { in: audience.roleKeys }, isActive: true } } } }]
            : []),
        ],
      },
      select: { id: true, permissions: { select: { effect: true, permission: { select: { key: true } } } } },
    });

    for (const user of users) {
      // An explicit DENY override must also suppress the notification, or we
      // would tell someone about an action they cannot see.
      const denied =
        audience.permission &&
        user.permissions.some(
          (p) => p.effect === 'DENY' && p.permission.key === audience.permission,
        );
      if (!denied) ids.add(user.id);
    }
  }

  if (audience.exceptUserId) ids.delete(audience.exceptUserId);
  return [...ids];
}

export async function notify(
  input: NotifyInput,
  audience: Audience,
  db: DbClient = prisma,
): Promise<string | null> {
  const recipients = await resolveAudience(audience, db);
  if (recipients.length === 0) {
    log.debug('Notification had no recipients', { eventKey: input.eventKey });
    return null;
  }

  const notification = await db.notification.create({
    data: {
      severity: input.severity,
      eventKey: input.eventKey,
      module: input.module,
      titleEn: input.titleEn,
      titleAr: input.titleAr,
      bodyEn: input.bodyEn,
      bodyAr: input.bodyAr,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      link: input.link ?? null,
      payload: input.payload ? JSON.stringify(input.payload) : null,
      expiresAt: input.expiresAt ?? null,
      isBroadcast: recipients.length > 1,
      createdById: input.createdById ?? null,
      recipients: { createMany: { data: recipients.map((userId) => ({ userId })) } },
    },
  });

  log.debug('Notification dispatched', {
    eventKey: input.eventKey,
    severity: input.severity,
    recipients: recipients.length,
  });

  return notification.id;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface InboxQuery {
  userId: string;
  severity?: Severity;
  module?: string;
  unreadOnly?: boolean;
  includeArchived?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function inbox(query: InboxQuery, db: DbClient = prisma) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
  const now = new Date();

  const where = {
    userId: query.userId,
    ...(query.unreadOnly ? { readAt: null } : {}),
    ...(query.includeArchived ? {} : { archivedAt: null }),
    notification: {
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.module ? { module: query.module } : {}),
      ...(query.search
        ? {
            OR: [
              { titleEn: containsInsensitive(query.search) },
              { titleAr: containsInsensitive(query.search) },
              { bodyEn: containsInsensitive(query.search) },
              { bodyAr: containsInsensitive(query.search) },
            ],
          }
        : {}),
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  };

  const [rows, total, unread] = await Promise.all([
    db.notificationRecipient.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { notification: true },
    }),
    db.notificationRecipient.count({ where }),
    unreadCount(query.userId, db),
  ]);

  return {
    rows,
    total,
    unread,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function unreadCount(userId: string, db: DbClient = prisma): Promise<number> {
  const now = new Date();
  return db.notificationRecipient.count({
    where: {
      userId,
      readAt: null,
      archivedAt: null,
      notification: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    },
  });
}

/** Unread counts split by severity — drives the badge colour in the shell. */
export async function unreadSummary(
  userId: string,
  db: DbClient = prisma,
): Promise<Record<Severity, number> & { total: number }> {
  const now = new Date();
  const rows = await db.notificationRecipient.findMany({
    where: {
      userId,
      readAt: null,
      archivedAt: null,
      notification: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    },
    select: { notification: { select: { severity: true } } },
  });

  const summary = { CRITICAL: 0, WARNING: 0, INFO: 0, SUCCESS: 0, total: 0 };
  for (const row of rows) {
    const severity = row.notification.severity as Severity;
    if (severity in summary) summary[severity]++;
    summary.total++;
  }
  return summary;
}

export async function markRead(
  recipientIds: string[],
  userId: string,
  db: DbClient = prisma,
): Promise<number> {
  const result = await db.notificationRecipient.updateMany({
    where: { id: { in: recipientIds }, userId, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

export async function markAllRead(userId: string, db: DbClient = prisma): Promise<number> {
  const result = await db.notificationRecipient.updateMany({
    where: { userId, readAt: null, archivedAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

export async function archive(
  recipientIds: string[],
  userId: string,
  db: DbClient = prisma,
): Promise<number> {
  const result = await db.notificationRecipient.updateMany({
    where: { id: { in: recipientIds }, userId },
    data: { archivedAt: new Date(), readAt: new Date() },
  });
  if (result.count === 0) throw errors.notFound('Notification');
  return result.count;
}

/** Housekeeping — drops read notifications past the retention window. */
export async function purgeOld(retentionDays: number, db: DbClient = prisma): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const result = await db.notification.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      recipients: { every: { readAt: { not: null } } },
    },
  });
  return result.count;
}
