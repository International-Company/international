/**
 * Moving money between the branch's own balances.
 *
 * ## What was wrong
 *
 * The broker settles in cash. Somebody takes it off his balance and puts it in
 * the till — and until now that was two unrelated funding movements, either of
 * which could happen without the other. When the second one did not, the branch
 * was poorer by the whole amount and the day's result had no line that
 * explained it: not profit, not loss, not an expense. Money lost in the
 * recording rather than in the counting, and days spent hunting a miscount that
 * never happened.
 *
 * So both sides are written here, in one database transaction, under one
 * reference, and reversed as one act. A half transfer is not a state this can
 * be in.
 *
 * ## Why it can stop in the middle anyway
 *
 * Because the money does. Cash carried to the bank leaves the till today and
 * lands in the account tomorrow. Booking both sides at once would show a bank
 * balance the branch cannot draw on yet — and paying a customer out of it is
 * not a blemish in a ledger, it is a cheque that bounces.
 *
 * So a transfer says whether it arrived. If it did not, the money moves into
 * `IN_TRANSIT` — a real drawer, because the cash really is between two places —
 * and waits there until somebody says it landed. Nothing pays out of it.
 *
 * ## Why only the manager may say it arrived
 *
 * Whoever can say "it arrived" can say it of money that never did, closing the
 * second half onto nothing at all and leaving the balances looking perfect. It
 * is also how the office already works: the sender posts the screenshot in the
 * group and the manager is the one who accepts it.
 *
 * ## Why the commission is not simply deducted
 *
 * Because the branch is poorer by it. If a transfer quietly arrived smaller
 * than it left, that loss would be reported as nothing — the transfer would
 * "balance" and the money would be gone. So the fee leaves the source as its
 * own expense movement, under the same reference, and the day's result counts
 * it as the cost it is.
 */

import 'server-only';
import { prisma, withTransaction, type DbClient } from '@/core/db/prisma';
import { errors } from '@/core/errors/app-error';
import { toDecimalString } from '@/core/money/money';
import { createLogger } from '@/core/logger/logger';
import * as audit from '@/modules/audit/audit.service';
import * as notifications from '@/modules/notifications/notifications.service';
import { currentOpenDay } from '@/modules/exchange/business-day.service';
import { nextReference } from '@/modules/sequence/reference';
import * as settings from '@/modules/settings/settings.service';
import * as drawers from './drawer.service';
import * as grants from './grant.service';
import { IN_TRANSIT, isTransferable, type DrawerKind } from './funding-categories';

const log = createLogger('transfers');

export type TransferStatus =
  | 'PENDING_APPROVAL'
  | 'PENDING_ARRIVAL'
  | 'COMPLETED'
  | 'REVERSED'
  | 'REJECTED';

export interface CreateTransfer {
  fromDrawerId: string;
  toDrawerId: string;
  amount: bigint;
  /** Left out to take whatever the account's rate says. */
  commission?: bigint | null;
  /** True when the money is already where it is going — cash over a counter. */
  arrivedImmediately?: boolean;
  account?: string | null;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The percentage each account keeps, by name.
 *
 * Stored once per account rather than typed on every transfer, because it is a
 * standing arrangement with a person and not a decision somebody makes each
 * time. Typing it per transfer would make the commission a matter of memory,
 * and the month's cost of moving money impossible to total honestly.
 *
 * Read as `name:percent` pairs — the same comma-separated shape the transfer
 * destinations already use, so there is one thing to learn rather than two.
 */
export async function commissionRates(db: DbClient = prisma): Promise<Map<string, number>> {
  const raw = await settings.getString('transfers.commissionRates', db);
  const rates = new Map<string, number>();

  for (const entry of raw.split(',')) {
    const [name, percent] = entry.split(':');
    const trimmed = name?.trim();
    const value = Number(percent?.trim());
    if (trimmed && Number.isFinite(value) && value >= 0) rates.set(trimmed, value);
  }

  return rates;
}

/** What an account would keep out of this amount, to the smallest unit. */
export function commissionOn(amount: bigint, percent: number): bigint {
  if (percent <= 0) return 0n;
  // Scaled by ten thousand so a rate like 0.25% survives as an integer, and
  // rounded down: the branch never over-reports what it paid away.
  const basisPoints = BigInt(Math.round(percent * 100));
  return (amount * basisPoints) / 10_000n;
}

/** Above this, somebody who is not the manager needs him to approve. */
async function approvalCeiling(db: DbClient = prisma): Promise<bigint | null> {
  const raw = (await settings.getString('transfers.approvalAbove', db)).trim();
  if (!raw) return null;
  try {
    const value = BigInt(Math.round(Number(raw) * 100_000_000));
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** How long a transfer may sit unarrived before it is worth chasing. */
async function standingDays(db: DbClient = prisma): Promise<number> {
  const raw = Number((await settings.getString('transfers.standingDays', db)).trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

// ---------------------------------------------------------------------------
// Making one
// ---------------------------------------------------------------------------

/**
 * Opens the in-transit drawer for a currency, if this is the first time money
 * has stopped in the middle in it.
 *
 * Created here rather than by the manager, and deliberately not offered on the
 * screen that opens drawers: nobody chooses to put money in transit, and a
 * drawer somebody could open, rename or close by hand would be a lever on the
 * machinery rather than a part of it. Idempotent, so two transfers leaving at
 * the same moment find the same drawer.
 */
async function ensureInTransit(currencyCode: string, db: DbClient) {
  const existing = await db.drawer.findUnique({
    where: {
      ownerKey_currencyCode_kind: {
        ownerKey: drawers.TREASURY,
        currencyCode,
        kind: IN_TRANSIT,
      },
    },
    select: { id: true },
  });
  if (existing) return existing;

  return db.drawer.create({
    data: {
      ownerKey: drawers.TREASURY,
      currencyCode,
      kind: IN_TRANSIT,
      nameEn: `${currencyCode} in transit`,
      nameAr: `${currencyCode} في الطريق`,
      // Last in the list: it is not a balance anybody works from, and putting
      // it among the tills would invite somebody to try.
      sortOrder: 900,
    },
    select: { id: true },
  });
}

async function loadPair(fromId: string, toId: string, db: DbClient) {
  const [from, to] = await Promise.all([
    db.drawer.findUnique({ where: { id: fromId } }),
    db.drawer.findUnique({ where: { id: toId } }),
  ]);

  if (!from) throw errors.notFound('Drawer', fromId);
  if (!to) throw errors.notFound('Drawer', toId);
  return { from, to };
}

/**
 * Everything that must be true before money moves.
 *
 * Gathered in one place and checked before anything is written, so a transfer
 * that is going to be refused is refused whole rather than half-applied.
 */
async function guard(
  from: { id: string; currencyCode: string; kind: string; isActive: boolean; nameAr: string; nameEn: string; balance: bigint; allowNegative: boolean },
  to: { id: string; currencyCode: string; kind: string; isActive: boolean; nameAr: string; nameEn: string },
  input: CreateTransfer,
  actor: drawers.Actor,
  db: DbClient,
) {
  if (from.id === to.id) {
    throw errors.precondition('A transfer needs two different drawers', 'errors.transferSameDrawer');
  }

  /*
   * Same currency, always.
   *
   * Shekels to dollars is not a transfer, it is an exchange: it has a rate and
   * a margin, and it belongs to the machine that prices them. Allowing it here
   * would open a way for money to leave one currency and arrive in another with
   * no rate recorded and no profit measured — after which the branch's takings
   * from exchange are no longer a number anybody can trust.
   */
  if (from.currencyCode !== to.currencyCode) {
    throw errors.precondition(
      'A transfer cannot change currency — use the exchange machine',
      'errors.transferCrossCurrency',
      { from: from.currencyCode, to: to.currencyCode },
    );
  }

  for (const drawer of [from, to]) {
    if (!drawer.isActive) {
      throw errors.precondition('That drawer is closed', 'errors.transferClosedDrawer', {
        drawer: drawer.nameAr || drawer.nameEn,
      });
    }
    if (!isTransferable(drawer.kind)) {
      throw errors.precondition(
        'Money cannot be transferred through that balance',
        'errors.transferKindNotAllowed',
        { drawer: drawer.nameAr || drawer.nameEn },
      );
    }
  }

  if (input.amount <= 0n) {
    throw errors.precondition('The amount must be more than nothing', 'errors.transferAmount');
  }

  // Both ends, not just the source. Somebody trusted to move money out of one
  // balance is not thereby trusted to decide where it lands.
  await grants.assertRight(actor, from, 'TRANSFER', db);
  await grants.assertRight(actor, to, 'TRANSFER', db);

  const covered = from.allowNegative || from.balance >= input.amount;
  if (!covered) {
    throw errors.insufficientFunds(
      from.currencyCode,
      from.kind,
      toDecimalString(from.balance, 2),
      toDecimalString(input.amount, 2),
    );
  }
}

/**
 * Records a transfer, and moves the money unless it needs approving first.
 *
 * Returns the transfer with its status, so the screen can tell "done" from
 * "waiting for you" from "waiting for the money" — three outcomes that look
 * identical if the caller only learns that nothing threw.
 */
export async function create(input: CreateTransfer, actor: drawers.Actor, db: DbClient = prisma) {
  const branchId = actor.branchId;
  if (!branchId) throw errors.precondition('No branch is assigned', 'errors.noBranch');

  const { from, to } = await loadPair(input.fromDrawerId, input.toDrawerId, db);
  await guard(from, to, input, actor, db);

  const day = await currentOpenDay(branchId, db, actor);

  // The account's standing rate, unless the caller named a figure. A manager
  // settling something unusual can still say what was actually kept.
  let commission = input.commission ?? null;
  if (commission === null && input.account) {
    const rates = await commissionRates(db);
    const percent = rates.get(input.account.trim());
    commission = percent ? commissionOn(input.amount, percent) : 0n;
  }
  commission ??= 0n;

  if (commission < 0n || commission >= input.amount) {
    throw errors.precondition(
      'The commission cannot be as large as the transfer',
      'errors.transferCommission',
    );
  }

  const ceiling = await approvalCeiling(db);
  const needsApproval =
    !grants.unrestricted(actor) && ceiling !== null && input.amount > ceiling;

  const reference = await nextReference('TRF', db);
  const arrives = input.amount - commission;

  const transfer = await db.transfer.create({
    data: {
      reference,
      fromDrawerId: from.id,
      toDrawerId: to.id,
      amount: input.amount,
      commission,
      status: needsApproval ? 'PENDING_APPROVAL' : 'COMPLETED',
      account: input.account?.trim() || null,
      note: input.note?.trim() || null,
      businessDayId: day.id,
      createdById: actor.id,
    },
  });

  if (needsApproval) {
    await notifications.notify(
      {
        severity: 'WARNING',
        eventKey: 'exchange.transfer.awaitingApproval',
        module: 'exchange',
        titleEn: 'A transfer is waiting for you',
        titleAr: 'تحويل ينتظر موافقتك',
        bodyEn: `${actor.name}: ${toDecimalString(input.amount, 2)} ${from.currencyCode} — ${reference}`,
        bodyAr: `${actor.name}: ${toDecimalString(input.amount, 2)} ${from.currencyCode} — ${reference}`,
        entityType: 'Transfer',
        entityId: transfer.id,
        link: '/manage/transfers',
        createdById: actor.id,
      },
      {
        permission: 'exchange.drawer.manage',
        branchId: actor.branchId ?? undefined,
        exceptUserId: actor.id,
      },
      db,
    );

    log.info('Transfer awaiting approval', { reference, amount: input.amount.toString() });
    return { ...transfer, status: 'PENDING_APPROVAL' as TransferStatus };
  }

  return applyMovement(transfer.id, input.arrivedImmediately === true, actor, db);
}

/**
 * Moves the money for a transfer that is cleared to move.
 *
 * Split out because approval and creation both end here, and because it is the
 * only place that writes both sides — one function to be sure of rather than
 * two that must agree.
 */
async function applyMovement(
  transferId: string,
  arrived: boolean,
  actor: drawers.Actor,
  db: DbClient = prisma,
) {
  return withTransaction(async (tx) => {
    const transfer = await tx.transfer.findUniqueOrThrow({
      where: { id: transferId },
      include: { fromDrawer: true, toDrawer: true },
    });

    const { fromDrawer: from, toDrawer: to } = transfer;
    const arrives = transfer.amount - transfer.commission;

    /*
     * The destination when the money has not landed yet.
     *
     * A drawer of its own rather than a flag, so the amount is somewhere it can
     * be counted and nowhere it can be spent.
     */
    const landing = arrived
      ? { currency: to.currencyCode, kind: to.kind as DrawerKind }
      : { currency: from.currencyCode, kind: IN_TRANSIT };

    // Opened on the way past, inside the same transaction as the movement that
    // needs it — so a transfer that fails leaves no empty drawer behind.
    if (!arrived) await ensureInTransit(from.currencyCode, tx);

    const movements: drawers.Movement[] = [
      {
        currency: from.currencyCode,
        kind: from.kind as DrawerKind,
        direction: 'OUT',
        amount: arrives,
        reason: 'TRANSFER',
        businessDayId: transfer.businessDayId,
        account: transfer.account,
        note: transfer.reference,
      },
      {
        currency: landing.currency,
        kind: landing.kind,
        direction: 'IN',
        amount: arrives,
        reason: 'TRANSFER',
        businessDayId: transfer.businessDayId,
        account: transfer.account,
        note: transfer.reference,
      },
    ];

    // The fee, as its own expense out of the source. Same reference, different
    // reason — so the day's result counts it and the transfer still balances.
    if (transfer.commission > 0n) {
      movements.push({
        currency: from.currencyCode,
        kind: from.kind as DrawerKind,
        direction: 'OUT',
        amount: transfer.commission,
        reason: 'FUNDING',
        category: 'EXPENSE',
        businessDayId: transfer.businessDayId,
        account: transfer.account,
        note: `${transfer.reference} — عمولة`,
      });
    }

    await drawers.move(movements, actor, tx);

    const updated = await tx.transfer.update({
      where: { id: transfer.id },
      data: {
        status: arrived ? 'COMPLETED' : 'PENDING_ARRIVAL',
        ...(arrived ? { confirmedById: actor.id, confirmedAt: new Date() } : {}),
      },
    });

    const fromName = from.nameAr || from.nameEn;
    const toName = arrived ? to.nameAr || to.nameEn : 'في الطريق';

    await audit.record({
      action: 'CREATE',
      module: 'exchange',
      entityType: 'Transfer',
      entityId: transfer.id,
      summaryEn: `Transfer ${transfer.reference}: ${toDecimalString(arrives, 2)} ${from.currencyCode} from ${from.nameEn} to ${arrived ? to.nameEn : 'in transit'}`,
      summaryAr: `تحويل ${transfer.reference}: ${toDecimalString(arrives, 2)} ${from.currencyCode} من ${fromName} إلى ${toName}`,
      actor,
      after: {
        reference: transfer.reference,
        amount: transfer.amount.toString(),
        commission: transfer.commission.toString(),
        status: updated.status,
      },
    }, tx);

    log.info('Transfer recorded', {
      reference: transfer.reference,
      status: updated.status,
      amount: transfer.amount.toString(),
    });

    return updated;
  }, db);
}

// ---------------------------------------------------------------------------
// Deciding on one
// ---------------------------------------------------------------------------

/** Lets a transfer that was held for approval go ahead, or refuses it. */
export async function decide(
  id: string,
  input: { approve: boolean; arrivedImmediately?: boolean; note?: string | null },
  actor: drawers.Actor,
  db: DbClient = prisma,
) {
  if (!grants.unrestricted(actor)) throw errors.forbidden('exchange.drawer.manage');

  const transfer = await db.transfer.findUnique({ where: { id } });
  if (!transfer) throw errors.notFound('Transfer', id);

  if (transfer.status !== 'PENDING_APPROVAL') {
    throw errors.precondition('That transfer is not waiting for approval', 'errors.transferNotPending');
  }

  if (!input.approve) {
    const rejected = await db.transfer.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approvedById: actor.id,
        approvedAt: new Date(),
        note: input.note?.trim() || transfer.note,
      },
    });

    await audit.record({
      action: 'UPDATE',
      module: 'exchange',
      entityType: 'Transfer',
      entityId: id,
      summaryEn: `Refused transfer ${transfer.reference}`,
      summaryAr: `رُفض التحويل ${transfer.reference}`,
      actor,
      after: { status: 'REJECTED' },
    });

    log.info('Transfer refused', { reference: transfer.reference });
    return rejected;
  }

  await db.transfer.update({
    where: { id },
    data: { approvedById: actor.id, approvedAt: new Date() },
  });

  return applyMovement(id, input.arrivedImmediately === true, actor, db);
}

/**
 * Says the money landed, and completes the second half.
 *
 * The manager's alone. See the note at the top of this file for why: this is
 * the one call that can make a transfer look finished without any money having
 * moved anywhere.
 */
export async function confirmArrival(
  id: string,
  input: { proof?: string | null } = {},
  actor: drawers.Actor,
  db: DbClient = prisma,
) {
  if (!grants.unrestricted(actor)) {
    throw errors.forbidden('exchange.drawer.manage', {
      message: 'Only a manager can confirm that a transfer arrived',
      messageKey: 'errors.transferConfirmManagerOnly',
    });
  }

  return withTransaction(async (tx) => {
    const transfer = await tx.transfer.findUniqueOrThrow({
      where: { id },
      include: { fromDrawer: true, toDrawer: true },
    });

    if (transfer.status !== 'PENDING_ARRIVAL') {
      throw errors.precondition('That transfer is not waiting to arrive', 'errors.transferNotInTransit');
    }

    const arrives = transfer.amount - transfer.commission;

    await drawers.move(
      [
        {
          currency: transfer.fromDrawer.currencyCode,
          kind: IN_TRANSIT,
          direction: 'OUT',
          amount: arrives,
          reason: 'TRANSFER',
          businessDayId: transfer.businessDayId,
          note: transfer.reference,
        },
        {
          currency: transfer.toDrawer.currencyCode,
          kind: transfer.toDrawer.kind as DrawerKind,
          direction: 'IN',
          amount: arrives,
          reason: 'TRANSFER',
          businessDayId: transfer.businessDayId,
          account: transfer.account,
          note: transfer.reference,
        },
      ],
      actor,
      tx,
    );

    const updated = await tx.transfer.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        confirmedById: actor.id,
        confirmedAt: new Date(),
        proof: input.proof?.trim() || transfer.proof,
      },
    });

    await audit.record({
      action: 'UPDATE',
      module: 'exchange',
      entityType: 'Transfer',
      entityId: id,
      summaryEn: `Transfer ${transfer.reference} arrived in ${transfer.toDrawer.nameEn}`,
      summaryAr: `وصل التحويل ${transfer.reference} إلى ${transfer.toDrawer.nameAr || transfer.toDrawer.nameEn}`,
      actor,
      after: { status: 'COMPLETED', proof: updated.proof },
    }, tx);

    log.info('Transfer arrived', { reference: transfer.reference });
    return updated;
  }, db);
}

/**
 * Undoes a transfer, both halves together.
 *
 * Only inside the day it was made. A day that has been closed has had its
 * result reported, and reaching back into it would change a figure somebody has
 * already acted on — after which "the profit for the fourteenth" stops being
 * one number.
 */
export async function reverse(
  id: string,
  reason: string | null,
  actor: drawers.Actor,
  db: DbClient = prisma,
) {
  if (!grants.unrestricted(actor)) throw errors.forbidden('exchange.drawer.manage');

  return withTransaction(async (tx) => {
    const transfer = await tx.transfer.findUniqueOrThrow({
      where: { id },
      include: { fromDrawer: true, toDrawer: true, businessDay: true },
    });

    if (transfer.status === 'REVERSED') {
      throw errors.precondition('That transfer is already reversed', 'errors.transferAlreadyReversed');
    }
    if (transfer.status === 'REJECTED' || transfer.status === 'PENDING_APPROVAL') {
      throw errors.precondition('That transfer never moved any money', 'errors.transferNothingToReverse');
    }
    if (transfer.businessDay.status === 'CLOSED') {
      throw errors.precondition(
        'That day is closed — correct it with a new entry instead',
        'errors.transferDayClosed',
      );
    }

    const arrives = transfer.amount - transfer.commission;

    // Where the money actually is right now, which is not always where the
    // transfer was headed.
    const holding =
      transfer.status === 'PENDING_ARRIVAL'
        ? { currency: transfer.fromDrawer.currencyCode, kind: IN_TRANSIT }
        : { currency: transfer.toDrawer.currencyCode, kind: transfer.toDrawer.kind as DrawerKind };

    const movements: drawers.Movement[] = [
      {
        currency: holding.currency,
        kind: holding.kind,
        direction: 'OUT',
        amount: arrives,
        reason: 'REVERSAL',
        businessDayId: transfer.businessDayId,
        note: `عكس ${transfer.reference}`,
      },
      {
        currency: transfer.fromDrawer.currencyCode,
        kind: transfer.fromDrawer.kind as DrawerKind,
        direction: 'IN',
        amount: arrives,
        reason: 'REVERSAL',
        businessDayId: transfer.businessDayId,
        note: `عكس ${transfer.reference}`,
      },
    ];

    // The fee comes back too. It was an expense of moving the money, and the
    // money did not move.
    if (transfer.commission > 0n) {
      movements.push({
        currency: transfer.fromDrawer.currencyCode,
        kind: transfer.fromDrawer.kind as DrawerKind,
        direction: 'IN',
        amount: transfer.commission,
        reason: 'FUNDING',
        category: 'EXPENSE',
        businessDayId: transfer.businessDayId,
        note: `عكس ${transfer.reference} — عمولة`,
      });
    }

    await drawers.move(movements, actor, tx);

    const updated = await tx.transfer.update({
      where: { id },
      data: {
        status: 'REVERSED',
        reversedById: actor.id,
        reversedAt: new Date(),
        note: reason?.trim() || transfer.note,
      },
    });

    await audit.record({
      action: 'REVERSE',
      module: 'exchange',
      entityType: 'Transfer',
      entityId: id,
      summaryEn: `Reversed transfer ${transfer.reference}`,
      summaryAr: `عُكس التحويل ${transfer.reference}`,
      actor,
      before: { status: transfer.status },
      after: { status: 'REVERSED', reason: reason ?? null },
    }, tx);

    log.info('Transfer reversed', { reference: transfer.reference });
    return updated;
  }, db);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface TransferFilter {
  status?: TransferStatus;
  drawerId?: string;
  from?: Date;
  to?: Date;
  minAmount?: bigint;
  limit?: number;
}

/** The log, narrowed by whatever the screen was asked to narrow it by. */
export async function list(
  filter: TransferFilter = {},
  actor?: drawers.Actor,
  db: DbClient = prisma,
) {
  const visible = actor ? await grants.visibleDrawerIds(actor, db) : null;

  const where: Record<string, unknown> = {};
  if (filter.status) where.status = filter.status;
  if (filter.minAmount !== undefined) where.amount = { gte: filter.minAmount };
  if (filter.from || filter.to) {
    where.createdAt = {
      ...(filter.from ? { gte: filter.from } : {}),
      ...(filter.to ? { lte: filter.to } : {}),
    };
  }

  /*
   * A drawer filter and a visibility filter are both "one of these two ends",
   * so they are combined with AND rather than merged — a delegate asking for a
   * drawer he cannot see must get nothing, not everything.
   */
  const ends: unknown[] = [];
  if (filter.drawerId) {
    ends.push({ OR: [{ fromDrawerId: filter.drawerId }, { toDrawerId: filter.drawerId }] });
  }
  if (visible !== null) {
    const ids = [...visible];
    ends.push({ OR: [{ fromDrawerId: { in: ids } }, { toDrawerId: { in: ids } }] });
  }
  if (ends.length) where.AND = ends;

  return db.transfer.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(filter.limit ?? 100, 500),
    include: {
      fromDrawer: { select: { id: true, nameAr: true, nameEn: true, kind: true, currencyCode: true } },
      toDrawer: { select: { id: true, nameAr: true, nameEn: true, kind: true, currencyCode: true } },
      createdBy: { select: { fullNameAr: true, fullNameEn: true } },
      confirmedBy: { select: { fullNameAr: true, fullNameEn: true } },
    },
  });
}

/**
 * What is still in the air, oldest first, with how long it has been there.
 *
 * Oldest first because this is a list to work through rather than read: the one
 * that has been waiting longest is the one worth a phone call.
 */
export async function outstanding(db: DbClient = prisma) {
  const rows = await db.transfer.findMany({
    where: { status: { in: ['PENDING_ARRIVAL', 'PENDING_APPROVAL'] } },
    orderBy: { createdAt: 'asc' },
    include: {
      fromDrawer: { select: { nameAr: true, nameEn: true, currencyCode: true } },
      toDrawer: { select: { nameAr: true, nameEn: true, currencyCode: true } },
      createdBy: { select: { fullNameAr: true, fullNameEn: true } },
    },
  });

  const days = await standingDays(db);
  const now = Date.now();

  return rows.map((row) => {
    const waitingDays = (now - row.createdAt.getTime()) / 86_400_000;
    return { ...row, waitingDays, standing: waitingDays >= days };
  });
}
