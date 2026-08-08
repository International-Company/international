import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';

/**
 * The business day — the daily open/close cycle every exchange office runs.
 *
 * Closing is not a formality: the operator physically counts each drawer, the
 * system compares that count against what the ledger says should be there, and
 * any difference is posted to a cash-difference account. A day that closes with
 * an unexplained difference is a finding, and it is recorded as one rather than
 * quietly absorbed.
 */

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
}

/** Normalises any timestamp to local midnight — the day's canonical key. */
export function dayKey(date: Date): Date {
  const key = new Date(date);
  key.setHours(0, 0, 0, 0);
  return key;
}

/**
 * Renders a business day as `YYYY-MM-DD` from its **local** calendar fields.
 *
 * `toISOString()` cannot be used here: a day key is local midnight, and in any
 * timezone ahead of UTC that instant belongs to the previous UTC date — so the
 * branch that opened on the 6th would be labelled the 5th in its own audit log.
 */
export function formatDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dayBounds(date: Date): { start: Date; end: Date } {
  const start = dayKey(date);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

export async function getDay(branchId: string, date: Date, db: DbClient = prisma) {
  return db.businessDay.findUnique({
    where: { branchId_date: { branchId, date: dayKey(date) } },
    include: {
      openedBy: { select: { fullNameEn: true, fullNameAr: true } },
      closedBy: { select: { fullNameEn: true, fullNameAr: true } },
    },
  });
}

export async function getCurrentDay(branchId: string, db: DbClient = prisma) {
  return getDay(branchId, new Date(), db);
}

/** Throws unless the branch's day for `date` is open. */
export async function requireOpenDay(branchId: string, date: Date, db: DbClient = prisma) {
  const day = await db.businessDay.findUnique({
    where: { branchId_date: { branchId, date: dayKey(date) } },
  });

  if (!day) {
    throw errors.precondition(
      `No business day is open for ${formatDayKey(dayKey(date))} — open the day before recording transactions`,
      'errors.dayNotOpen',
    );
  }
  if (day.status === 'CLOSED') {
    throw errors.dayClosed(formatDayKey(dayKey(date)));
  }
  if (day.status === 'CLOSING') {
    throw errors.precondition(
      'The day is being closed — no further transactions can be posted',
      'errors.dayClosing',
    );
  }

  return day;
}

export async function openDay(
  branchId: string,
  actor: Actor,
  options: { date?: Date; notes?: string } = {},
  db: DbClient = prisma,
) {
  const date = dayKey(options.date ?? new Date());

  return withTransaction(async (tx) => {
    const branch = await tx.branch.findUnique({ where: { id: branchId } });
    if (!branch) throw errors.notFound('Branch', branchId);

    const existing = await tx.businessDay.findUnique({
      where: { branchId_date: { branchId, date } },
    });
    if (existing) {
      throw errors.conflict(
        `The day ${formatDayKey(date)} is already ${existing.status.toLowerCase()}`,
        'errors.dayAlreadyExists',
      );
    }

    const day = await tx.businessDay.create({
      data: {
        branchId,
        date,
        status: 'OPEN',
        openedById: actor.id,
        notes: options.notes ?? null,
      },
    });

    await audit.record(
      {
        action: 'DAY_OPEN',
        module: 'exchange',
        entityType: 'BusinessDay',
        entityId: day.id,
        summaryEn: `Opened business day ${formatDayKey(date)} for ${branch.nameEn}`,
        summaryAr: `فتح يوم العمل ${formatDayKey(date)} لفرع ${branch.nameAr}`,
        actor,
      },
      tx,
    );

    emitAsync('day.opened', { businessDayId: day.id, branchId, actorId: actor.id });
    return day;
  }, db);
}


/**
 * Closes the day.
 *
 * There is no count sheet and no variance posting any more: those existed to
 * reconcile a ledger against physical cash, and the ledger is gone. What closing
 * still does is draw a line — after it, the day's transactions are a fixed set
 * the manager can review, and nothing further can be recorded against it.
 */
export async function closeDay(
  branchId: string,
  actor: Actor,
  options: { date?: Date; notes?: string } = {},
  db: DbClient = prisma,
) {
  const date = dayKey(options.date ?? new Date());

  return withTransaction(async (tx) => {
    const day = await tx.businessDay.findUnique({
      where: { branchId_date: { branchId, date } },
      include: { branch: true },
    });

    if (!day) throw errors.notFound('Business day', formatDayKey(date));
    if (day.status === 'CLOSED') {
      throw errors.conflict('This day is already closed', 'errors.dayAlreadyClosed');
    }

    const closed = await tx.businessDay.update({
      where: { id: day.id },
      data: {
        status: 'CLOSED',
        closedById: actor.id,
        closedAt: new Date(),
        notes: options.notes ?? day.notes,
      },
    });

    const posted = await tx.transaction.count({
      where: { businessDayId: day.id, status: 'POSTED' },
    });

    await audit.record(
      {
        action: 'DAY_CLOSE',
        module: 'exchange',
        entityType: 'BusinessDay',
        entityId: day.id,
        summaryEn: `Closed business day ${formatDayKey(date)} for ${day.branch.nameEn} — ${posted} transaction(s)`,
        summaryAr: `إغلاق يوم العمل ${formatDayKey(date)} لفرع ${day.branch.nameAr} — ${posted} عملية`,
        actor,
      },
      tx,
    );

    emitAsync('day.closed', {
      businessDayId: day.id,
      branchId,
      actorId: actor.id,
      hasDifference: false,
    });

    return { day: closed, transactions: posted };
  }, db);
}

/**
 * Reopens a closed day so a correction can be recorded against it.
 *
 * Deliberately audited as its own action rather than folded into closing: a day
 * that was closed and then reopened is the shape of an afterthought, and a
 * manager reviewing later should be able to see that it happened.
 */
export async function reopenDay(
  branchId: string,
  actor: Actor,
  options: { date?: Date; reason?: string } = {},
  db: DbClient = prisma,
) {
  const date = dayKey(options.date ?? new Date());

  return withTransaction(async (tx) => {
    const day = await tx.businessDay.findUnique({
      where: { branchId_date: { branchId, date } },
      include: { branch: true },
    });

    if (!day) throw errors.notFound('Business day', formatDayKey(date));
    if (day.status !== 'CLOSED') {
      throw errors.conflict('This day is not closed', 'errors.dayNotClosed');
    }

    const reopened = await tx.businessDay.update({
      where: { id: day.id },
      data: { status: 'REOPENED', closedById: null, closedAt: null },
    });

    await audit.record(
      {
        action: 'DAY_REOPEN',
        module: 'exchange',
        entityType: 'BusinessDay',
        entityId: day.id,
        summaryEn: `Reopened business day ${formatDayKey(date)}${options.reason ? `: ${options.reason}` : ''}`,
        summaryAr: `إعادة فتح يوم العمل ${formatDayKey(date)}${options.reason ? `: ${options.reason}` : ''}`,
        actor,
      },
      tx,
    );

    return reopened;
  }, db);
}

/** Recent days, for the manager's panel. */
export async function listDays(branchId: string, limit = 14, db: DbClient = prisma) {
  const days = await db.businessDay.findMany({
    where: { branchId },
    orderBy: { date: 'desc' },
    take: Math.min(limit, 60),
    include: {
      openedBy: { select: { fullNameEn: true, fullNameAr: true } },
      closedBy: { select: { fullNameEn: true, fullNameAr: true } },
      _count: { select: { transactions: true } },
    },
  });

  return days;
}
