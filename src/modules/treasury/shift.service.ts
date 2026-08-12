import 'server-only';
import { prisma, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import { nextReference } from '@/modules/sequence/reference';
import * as drawers from '@/modules/drawers/drawer.service';
import * as audit from '@/modules/audit/audit.service';
import * as reports from './shift-report.service';

/**
 * الورديّة — a teller's stretch of work, and the count that ends it.
 *
 * It opens when a float is handed in and closes when one is handed back, so it
 * needs no button of its own: taking the bag *is* starting, and giving it back
 * *is* finishing.
 *
 * The whole design rests on the cash drawer ending at zero. That is what makes
 * the count absolute rather than cumulative:
 *
 *     what should be there  =  the float  +  what the teller traded
 *     what is there         =  what the two of them counted
 *     the gap               =  a difference, belonging to nobody yet
 *
 * No carry-over from yesterday, no interpretation. And because it is zero every
 * night, a shortage cannot hide behind a surplus from a week ago.
 */

const log = createLogger('treasury:shift');

/** Where an unexplained gap waits until somebody decides whose it was. */
const DIFFERENCE: drawers.DrawerKind = 'DIFFERENCE';

export interface Actor {
  id: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  sessionId?: string;
  permissions: string[];
  branchId?: string | null;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/**
 * Starts a shift when a float is taken, unless one is already running.
 *
 * Called from the handover the teller has just counted and accepted, inside its
 * transaction: the money arriving and the shift beginning are the same event,
 * and a failure between them would leave a teller holding a float on no shift.
 */
export async function openFromHandover(
  handover: { id: string; tellerId: string; branchId: string; businessDayId: string | null },
  tx: DbClient,
): Promise<void> {
  const running = await tx.shift.findFirst({
    where: { tellerId: handover.tellerId, status: 'OPEN' },
    select: { id: true },
  });
  // A top-up mid-shift is still a handover, and must not start a second one.
  if (running) return;

  const reference = await nextReference('SHF', tx);

  await tx.shift.create({
    data: {
      reference,
      tellerId: handover.tellerId,
      branchId: handover.branchId,
      businessDayId: handover.businessDayId,
      status: 'OPEN',
      openingHandoverId: handover.id,
    },
  });

  log.info('Shift opened', { reference, tellerId: handover.tellerId });
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/**
 * Reconciles a teller to what was actually counted, then lets the money move.
 *
 * Called from the closing handover **before** its movements are applied, and
 * the order is not incidental. A surplus — more counted than the books say —
 * would otherwise ask the teller's drawer to pay out more than it holds, and it
 * would rightly refuse. Booking the gap first sets the drawer to exactly what
 * was counted, so the handover that follows always leaves it at zero.
 *
 * Two different comparisons happen at a close, and conflating them would hide
 * one of them:
 *
 *   - declared against counted — a disagreement between two people, which
 *     disputes the handover and moves nothing. That is the handover's business.
 *   - expected against counted — a disagreement between the books and the
 *     world. That is this, and it is always booked, because the money is
 *     already wherever it actually is.
 */
export async function reconcileForClosing(
  handover: {
    id: string;
    tellerId: string;
    branchId: string;
    businessDayId: string | null;
    lines: { currencyCode: string; kind: string; nature: string }[];
  },
  counted: Map<string, bigint>,
  actor: Actor,
  tx: DbClient,
): Promise<void> {
  const shift = await tx.shift.findFirst({
    where: { tellerId: handover.tellerId, status: 'OPEN' },
  });
  if (!shift) return;

  const owner = drawers.tellerOwner(handover.tellerId);

  for (const line of handover.lines) {
    // An allocated line never changed hands, so it cannot be miscounted; what
    // it says is what it is.
    if (line.nature !== 'COUNTED') continue;

    const key = `${line.currencyCode}:${line.kind}`;
    const actual = counted.get(key);
    if (actual === undefined) continue;

    const held = await tx.drawer.findUnique({
      where: {
        ownerKey_currencyCode_kind: {
          ownerKey: owner,
          currencyCode: line.currencyCode,
          kind: line.kind,
        },
      },
    });
    if (!held) continue;

    const gap = held.balance - actual;
    if (gap === 0n) continue;

    await ensureDifferenceDrawer(line.currencyCode, tx);

    /*
     * A shortage takes the missing amount out of the teller and parks it in the
     * differences balance; a surplus does the reverse. Either way the office is
     * worth exactly what it was a moment ago — the cash has not changed, only
     * the name of the place the books keep it under.
     */
    await drawers.move(
      [
        {
          currency: line.currencyCode,
          kind: line.kind as drawers.DrawerKind,
          owner,
          direction: gap > 0n ? 'OUT' : 'IN',
          amount: gap > 0n ? gap : -gap,
          reason: 'DIFFERENCE',
          businessDayId: handover.businessDayId,
          note: shift.reference,
        },
        {
          currency: line.currencyCode,
          kind: DIFFERENCE,
          owner: drawers.TREASURY,
          direction: gap > 0n ? 'IN' : 'OUT',
          amount: gap > 0n ? gap : -gap,
          reason: 'DIFFERENCE',
          businessDayId: handover.businessDayId,
          note: shift.reference,
        },
      ],
      actor,
      tx,
    );

    await tx.discrepancy.create({
      data: {
        shiftId: shift.id,
        tellerId: handover.tellerId,
        businessDayId: handover.businessDayId,
        currencyCode: line.currencyCode,
        amount: gap,
        status: 'OPEN',
      },
    });

    log.warn('Discrepancy recorded', {
      shift: shift.reference,
      currency: line.currencyCode,
      gap: gap.toString(),
    });
  }
}

/** Marks the shift finished, once its closing handover has moved the money. */
export async function closeFromHandover(
  handover: { id: string; tellerId: string },
  actor: Actor,
  tx: DbClient,
): Promise<void> {
  const shift = await tx.shift.findFirst({
    where: { tellerId: handover.tellerId, status: 'OPEN' },
  });
  if (!shift) return;

  await tx.shift.update({
    where: { id: shift.id },
    data: { status: 'CLOSED', closedAt: new Date(), closingHandoverId: handover.id },
  });

  /*
   * The teller's own report, written here rather than asked of him — and inside
   * this transaction, so a closed shift always has one. If it cannot be
   * composed the handover fails with it and nothing has moved: he counts again,
   * which costs a minute, rather than the office keeping a shift with no record
   * of what happened in it.
   */
  await reports.writeForShift(shift, handover.id, tx);

  const found = await tx.discrepancy.count({ where: { shiftId: shift.id } });

  await audit.record(
    {
      action: 'UPDATE',
      module: 'exchange',
      entityType: 'Shift',
      entityId: shift.id,
      summaryEn: `Closed shift ${shift.reference} — ${found} difference(s)`,
      summaryAr: `إغلاق الورديّة ${shift.reference} — ${found} فرق`,
      actor,
    },
    tx,
  );

  log.info('Shift closed', { reference: shift.reference, discrepancies: found });
}

/** Opens the treasury's differences balance for a currency if it has none. */
async function ensureDifferenceDrawer(currency: string, tx: DbClient): Promise<void> {
  const existing = await tx.drawer.findUnique({
    where: {
      ownerKey_currencyCode_kind: {
        ownerKey: drawers.TREASURY,
        currencyCode: currency,
        kind: DIFFERENCE,
      },
    },
  });
  if (existing) return;

  const row = await tx.currency.findUniqueOrThrow({ where: { code: currency } });

  await tx.drawer.create({
    data: {
      ownerKey: drawers.TREASURY,
      currencyCode: currency,
      kind: DIFFERENCE,
      nameEn: `${row.nameEn} — differences`,
      nameAr: `فروقات — ${row.nameAr}`,
      /*
       * It goes both ways. A shortage pushes it up and a surplus pulls it
       * below zero, and a surplus is every bit as real as a shortage: somebody
       * was probably given less than they were owed.
       */
      allowNegative: true,
      sortOrder: row.sortOrder * 10 + 3,
    },
  });
}

/**
 * Whose cash a person's trading moves.
 *
 * A teller on shift works out of the drawer they counted and will hand back, so
 * every note that crosses their counter has to come from and go into *their*
 * balance. Otherwise the shift's arithmetic is empty: what should be there
 * would be the float and nothing else, and the count would only ever prove that
 * the bag came back.
 *
 * Anyone not on a shift — the manager at the same counter — works out of the
 * treasury, which is exactly where their money is.
 *
 * Cash only. The broker and the correspondent stay with the treasury until they
 * are allocated too; a teller instructing a bank transfer is drawing on the
 * office's claim, not on anything in their drawer.
 */
export async function cashOwnerFor(userId: string, db: DbClient = prisma): Promise<string> {
  const open = await db.shift.findFirst({
    where: { tellerId: userId, status: 'OPEN' },
    select: { id: true },
  });
  return open ? drawers.tellerOwner(userId) : drawers.TREASURY;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function current(tellerId: string, db: DbClient = prisma) {
  return db.shift.findFirst({
    where: { tellerId, status: 'OPEN' },
    include: { openingHandover: { include: { lines: true } } },
  });
}

export async function listShifts(
  filter: { tellerId?: string; limit?: number } = {},
  db: DbClient = prisma,
) {
  return db.shift.findMany({
    where: filter.tellerId ? { tellerId: filter.tellerId } : {},
    orderBy: { openedAt: 'desc' },
    take: Math.min(filter.limit ?? 20, 100),
    include: {
      teller: { select: { fullNameEn: true, fullNameAr: true } },
      discrepancies: true,
    },
  });
}

/**
 * Every difference nobody has ruled on, oldest first.
 *
 * Oldest first because age is the thing that matters about them: a suspense
 * account is only honest for as long as somebody is still looking at it.
 */
export async function openDiscrepancies(db: DbClient = prisma) {
  return db.discrepancy.findMany({
    where: { status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
    include: {
      teller: { select: { id: true, fullNameEn: true, fullNameAr: true } },
      shift: { select: { reference: true } },
      currency: { select: { decimals: true } },
    },
  });
}

/** How long the oldest unresolved difference has been waiting, in days. */
export async function oldestOpenAgeDays(db: DbClient = prisma): Promise<number | null> {
  const oldest = await db.discrepancy.findFirst({
    where: { status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (!oldest) return null;

  return Math.floor((Date.now() - oldest.createdAt.getTime()) / 86_400_000);
}
