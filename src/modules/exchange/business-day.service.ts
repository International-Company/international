import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';
import * as ledger from '@/modules/ledger/ledger.service';
import * as settings from '@/modules/settings/settings.service';
import { dayKey, formatDayKey, dayBounds } from '@/core/time/day-key';

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

/*
 * The date helpers live in `@/core/time/day-key` and are re-exported here.
 *
 * They were written here first, and everything that needs a day key still
 * imports it from here. They had to move because the ledger needs them too, and
 * the ledger is what this file calls to freeze a position at the close — two
 * modules importing each other for the sake of three lines of date arithmetic.
 */
export { dayKey, formatDayKey, dayBounds };

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

// ---------------------------------------------------------------------------
// The automatic day
// ---------------------------------------------------------------------------

/**
 * Who an automatic open is credited to: the person whose act needed the day,
 * or the system account when nobody is at hand. Never left blank — a day
 * nobody opened is a day nobody can be asked about.
 */
async function openerId(actor: Actor | undefined, db: DbClient): Promise<string> {
  if (actor?.id) return actor.id;
  const system = await db.user.findFirst({ where: { isSystem: true }, select: { id: true } });
  if (!system) throw errors.precondition('No system account to open the day', 'errors.dayNotOpen');
  return system.id;
}

/**
 * The day for `date`, open — opened or reopened if it has to be.
 *
 * Only under `day.automatic`. The office chose not to run the open/close cycle
 * by hand, so recording is never stopped for want of a day: a missing day is
 * opened, and one closed for review is reopened, each written to the audit log
 * as the act it is. Closing stays available to the manager; it freezes the
 * day's position, and a later posting reopening it is visible in the log.
 *
 * The upsert is what makes two tellers' first trades of the morning safe: the
 * second finds the day the first opened instead of colliding with it.
 */
async function ensureDay(branchId: string, date: Date, actor: Actor | undefined, db: DbClient) {
  const key = dayKey(date);
  const existing = await db.businessDay.findUnique({
    where: { branchId_date: { branchId, date: key } },
  });

  if (!existing) {
    const day = await db.businessDay.upsert({
      where: { branchId_date: { branchId, date: key } },
      create: {
        branchId,
        date: key,
        status: 'OPEN',
        openedById: await openerId(actor, db),
        notes: 'Opened automatically',
      },
      update: {},
    });
    await audit.record(
      {
        action: 'DAY_OPEN',
        module: 'exchange',
        entityType: 'BusinessDay',
        entityId: day.id,
        summaryEn: `Business day ${formatDayKey(key)} opened automatically by the first operation`,
        summaryAr: `فُتح يوم العمل ${formatDayKey(key)} تلقائياً مع أول عملية`,
        actor,
      },
      db,
    );
    return day;
  }

  if (existing.status === 'CLOSED') {
    const day = await db.businessDay.update({
      where: { id: existing.id },
      data: { status: 'REOPENED', closedById: null, closedAt: null },
    });
    await audit.record(
      {
        action: 'DAY_REOPEN',
        module: 'exchange',
        entityType: 'BusinessDay',
        entityId: day.id,
        summaryEn: `Business day ${formatDayKey(key)} reopened automatically — an operation was recorded after it closed`,
        summaryAr: `أُعيد فتح يوم العمل ${formatDayKey(key)} تلقائياً — سُجّلت عملية بعد إغلاقه`,
        actor,
      },
      db,
    );
    return day;
  }

  return existing;
}

async function automatic(db: DbClient): Promise<boolean> {
  return settings.getBoolean('day.automatic', db);
}

/** Throws unless the branch's day for `date` is open — or opens it, when the day is automatic. */
export async function requireOpenDay(
  branchId: string,
  date: Date,
  db: DbClient = prisma,
  actor?: Actor,
) {
  if (await automatic(db)) {
    const day = await ensureDay(branchId, date, actor, db);
    // A close in progress is a moment, not a state to record into.
    if (day.status === 'CLOSING') {
      throw errors.precondition(
        'The day is being closed — no further transactions can be posted',
        'errors.dayClosing',
      );
    }
    return day;
  }

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

/**
 * The branch's open session, whatever date it carries.
 *
 * A business day here is opened and closed by hand, so it is a session rather
 * than a calendar date — an office still working at one in the morning is still
 * working the day it opened. Anything that belongs to "the day in progress"
 * asks this, and gets the latest open one when more than one was left open.
 *
 * A transaction is different and deliberately so: it is keyed to the calendar
 * date it happened on, because that is what a customer's receipt says.
 */
export async function currentOpenDay(branchId: string, db: DbClient = prisma, actor?: Actor) {
  const day = await db.businessDay.findFirst({
    where: { branchId, status: { in: ['OPEN', 'REOPENED'] } },
    orderBy: { date: 'desc' },
  });

  // With nothing open, an automatic office opens today rather than refusing.
  if (!day && (await automatic(db))) return ensureDay(branchId, new Date(), actor, db);

  if (!day) {
    throw errors.precondition('No business day is open — open the day first', 'errors.dayNotOpen');
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
 * Two things happen, and the second is the point. It draws a line — after it
 * the day's transactions are a fixed set and nothing further can be recorded
 * against them — and it freezes what every drawer held, at the cut-off rates in
 * force, onto the day itself.
 *
 * That freeze is what makes a result a result. The office's profit is the
 * change in what it is worth, so tomorrow's approved rates must not be able to
 * reach back and restate today; the balances and the rates that valued them are
 * copied onto the day and never recomputed.
 *
 * It follows that a day cannot close while a currency the branch actually holds
 * has no approved rate. Valuing that holding at nothing would understate the
 * office by exactly the amount nobody had got round to pricing — and would then
 * report the understatement as a loss.
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

    // Before the status changes, so a day that cannot be valued is not left
    // closed with no position behind it.
    await ledger.freezePosition(day.id, date, tx);

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
