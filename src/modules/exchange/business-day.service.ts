import 'server-only';
import { prisma, withTransaction, type DbClient, type Tx } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { emitAsync } from '@/core/events/bus';
import * as audit from '@/modules/audit/audit.service';
import { movements, postEntry } from '@/modules/ledger/ledger.service';
import { ACCOUNT_CODES } from '@/modules/ledger/accounts';

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

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

export interface ClosingSheetRow {
  accountId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  currencyCode: string;
  kind: string;
  openingBalance: bigint;
  totalIn: bigint;
  totalOut: bigint;
  systemBalance: bigint;
}

/**
 * Builds the count sheet: for every cash and bank account, what the ledger says
 * should be in the drawer right now, and how it got there today.
 */
export async function closingSheet(
  branchId: string,
  date: Date,
  db: DbClient = prisma,
): Promise<ClosingSheetRow[]> {
  const { start, end } = dayBounds(date);

  const accounts = await db.account.findMany({
    where: {
      isActive: true,
      kind: { in: ['CASH', 'BANK', 'CRYPTO'] },
      OR: [{ branchId }, { branchId: null }],
    },
    orderBy: [{ currencyCode: 'asc' }, { sortOrder: 'asc' }],
  });

  const rows: ClosingSheetRow[] = [];

  for (const account of accounts) {
    const today = await movements(account.id, start, end, db);
    // Opening = closing minus today's net movement. Cash and bank are asset
    // accounts, so debits add and credits subtract.
    const net = today.debit - today.credit;

    rows.push({
      accountId: account.id,
      code: account.code,
      nameEn: account.nameEn,
      nameAr: account.nameAr,
      currencyCode: account.currencyCode,
      kind: account.kind,
      openingBalance: account.balance - net,
      totalIn: today.debit,
      totalOut: today.credit,
      systemBalance: account.balance,
    });
  }

  return rows;
}

export interface CountedBalance {
  accountId: string;
  countedBalance: bigint;
  note?: string;
}

export interface CloseDayResult {
  businessDayId: string;
  differences: {
    accountId: string;
    code: string;
    currencyCode: string;
    difference: bigint;
  }[];
  transactionCount: number;
}

/**
 * Closes the day.
 *
 * Every counted difference is posted to the cash-difference account so the
 * ledger continues to agree with the physical drawer. Absorbing a shortage
 * silently would leave the books internally consistent but wrong, which is the
 * failure mode a daily close exists to prevent.
 */
export async function closeDay(
  branchId: string,
  counts: CountedBalance[],
  actor: Actor,
  options: { date?: Date; notes?: string } = {},
  db: DbClient = prisma,
): Promise<CloseDayResult> {
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

    // Block new postings for the duration of the count.
    await tx.businessDay.update({ where: { id: day.id }, data: { status: 'CLOSING' } });


    const sheet = await closingSheet(branchId, date, tx);
    const sheetByAccount = new Map(sheet.map((row) => [row.accountId, row]));
    const countByAccount = new Map(counts.map((c) => [c.accountId, c]));

    const differences: CloseDayResult['differences'] = [];

    for (const row of sheet) {
      const counted = countByAccount.get(row.accountId);
      // An uncounted drawer is recorded as matching, not as a zero count —
      // treating "not counted" as "empty" would post a fictitious shortage.
      const countedBalance = counted ? counted.countedBalance : row.systemBalance;
      const difference = countedBalance - row.systemBalance;

      await tx.dayClosingLine.upsert({
        where: { businessDayId_accountId: { businessDayId: day.id, accountId: row.accountId } },
        create: {
          businessDayId: day.id,
          accountId: row.accountId,
          currencyCode: row.currencyCode,
          openingBalance: row.openingBalance,
          totalIn: row.totalIn,
          totalOut: row.totalOut,
          systemBalance: row.systemBalance,
          countedBalance,
          difference,
          note: counted?.note ?? null,
        },
        update: {
          openingBalance: row.openingBalance,
          totalIn: row.totalIn,
          totalOut: row.totalOut,
          systemBalance: row.systemBalance,
          countedBalance,
          difference,
          note: counted?.note ?? null,
        },
      });

      if (difference !== 0n) {
        differences.push({
          accountId: row.accountId,
          code: row.code,
          currencyCode: row.currencyCode,
          difference,
        });

        // Bring the ledger to the counted reality and book the variance.
        const shortageAccount = await tx.account.findUnique({
          where: { code: ACCOUNT_CODES.expenseShortage(row.currencyCode) },
        });
        if (!shortageAccount) {
          throw errors.precondition(
            `Missing cash-difference account for ${row.currencyCode}`,
            'errors.missingAccount',
          );
        }

        await postEntry(
          {
            description: `Cash count difference ${row.code} — ${formatDayKey(date)}`,
            descriptionAr: `فرق جرد الصندوق ${row.code} — ${formatDayKey(date)}`,
            valueDate: date,
            createdById: actor.id,
            lines:
              difference > 0n
                ? [
                    { accountId: row.accountId, debit: difference, memo: 'Cash count surplus' },
                    { accountId: shortageAccount.id, credit: difference, memo: 'Cash count surplus' },
                  ]
                : [
                    { accountId: shortageAccount.id, debit: -difference, memo: 'Cash count shortage' },
                    { accountId: row.accountId, credit: -difference, memo: 'Cash count shortage' },
                  ],
          },
          tx,
        );
      }
    }

    const transactionCount = await tx.transaction.count({
      where: { businessDayId: day.id, status: 'POSTED' },
    });

    await tx.businessDay.update({
      where: { id: day.id },
      data: {
        status: 'CLOSED',
        closedById: actor.id,
        closedAt: new Date(),
        notes: options.notes ?? day.notes,
      },
    });

    await audit.record(
      {
        action: 'DAY_CLOSE',
        module: 'exchange',
        entityType: 'BusinessDay',
        entityId: day.id,
        summaryEn:
          `Closed business day ${formatDayKey(date)} for ${day.branch.nameEn} — ` +
          `${transactionCount} transaction(s), ${differences.length} difference(s)`,
        summaryAr:
          `إغلاق يوم العمل ${formatDayKey(date)} لفرع ${day.branch.nameAr} — ` +
          `${transactionCount} عملية، ${differences.length} فرق`,
        actor,
        metadata: {
          transactionCount,
          differences: differences.map((d) => ({
            code: d.code,
            difference: toDecimalString(d.difference, 2),
            currency: d.currencyCode,
          })),
        },
      },
      tx,
    );

    emitAsync('day.closed', {
      businessDayId: day.id,
      branchId,
      actorId: actor.id,
      hasDifference: differences.length > 0,
    });

    void sheetByAccount; // sheet retained above for clarity of intent
    return { businessDayId: day.id, differences, transactionCount };
  }, db);
}

/** Reopens a closed day for correction. Always a sensitive, audited action. */
export async function reopenDay(
  businessDayId: string,
  reason: string,
  actor: Actor,
  db: DbClient = prisma,
): Promise<void> {
  await withTransaction(async (tx: Tx) => {
    const day = await tx.businessDay.findUnique({
      where: { id: businessDayId },
      include: { branch: true },
    });
    if (!day) throw errors.notFound('Business day', businessDayId);
    if (day.status !== 'CLOSED') {
      throw errors.conflict('Only a closed day can be reopened', 'errors.dayNotClosed');
    }

    await tx.businessDay.update({
      where: { id: businessDayId },
      data: { status: 'REOPENED', closedAt: null, closedById: null },
    });

    await audit.record(
      {
        action: 'DAY_REOPEN',
        module: 'exchange',
        entityType: 'BusinessDay',
        entityId: businessDayId,
        summaryEn: `Reopened business day ${formatDayKey(day.date)}: ${reason}`,
        summaryAr: `إعادة فتح يوم العمل ${formatDayKey(day.date)}: ${reason}`,
        actor,
        metadata: { reason },
      },
      tx,
    );
  }, db);
}

export async function listDays(
  branchId: string,
  options: { limit?: number } = {},
  db: DbClient = prisma,
) {
  return db.businessDay.findMany({
    where: { branchId },
    orderBy: { date: 'desc' },
    take: Math.min(365, options.limit ?? 60),
    include: {
      openedBy: { select: { fullNameEn: true, fullNameAr: true } },
      closedBy: { select: { fullNameEn: true, fullNameAr: true } },
      _count: { select: { transactions: true } },
    },
  });
}

export async function dayDetail(businessDayId: string, db: DbClient = prisma) {
  const day = await db.businessDay.findUnique({
    where: { id: businessDayId },
    include: {
      branch: true,
      openedBy: { select: { fullNameEn: true, fullNameAr: true } },
      closedBy: { select: { fullNameEn: true, fullNameAr: true } },
      closingLines: {
        include: { account: { select: { code: true, nameEn: true, nameAr: true, kind: true } } },
      },
    },
  });
  if (!day) throw errors.notFound('Business day', businessDayId);
  return day;
}
